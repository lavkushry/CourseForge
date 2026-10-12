#!/usr/bin/env python3
"""Measure the legacy HTTP API using only a fresh synthetic, disposable database.

This small same-host baseline is not a capacity certification. It never snapshots
the configured library and does not call video, AI, mail, or lab providers.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import hashlib
from importlib.metadata import version
import json
import math
import os
from pathlib import Path
import platform
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time

import httpx

ROOT = Path(__file__).resolve().parents[1]


def synthetic_environment(directory: Path, base: str) -> dict[str, str]:
    # Explicit empty values override dotenv and legacy provider fallback values.
    env = dict(os.environ, DATA_DIR=str(directory / "data"), COURSES_DIR=str(directory / "courses"),
               COOKIE_SECURE="0", ALLOWED_HOSTS="127.0.0.1", PUBLIC_BASE_URL=base,
               SMTP_HOST="", SMTP_FROM="", SMTP_USER="", SMTP_PASSWORD="", REGISTRATION_MODE="invite",
               OLLAMA_URL="http://127.0.0.1:1", QDRANT_URL="http://127.0.0.1:1", ENABLE_KIND_LABS="0",
               PYTHONPATH=str(ROOT), PYTHONDONTWRITEBYTECODE="1")
    for suffix in ("", "_2", "_3"):
        env["ODYSEE_AUTH_TOKEN" + suffix] = ""
        env["ODYSEE_CHANNEL_ID" + suffix] = ""
    return env


def seed(directory: Path, users: int) -> None:
    # The parent invokes this only in a child with the isolated DATA_DIR already set.
    sys.path.insert(0, str(ROOT))
    from app import db
    if db.settings.data_dir != (directory / "data").resolve():
        raise RuntimeError("Refusing to seed outside the requested temporary data directory")
    db.settings.courses_dir.mkdir(parents=True, exist_ok=True)
    db.init_db()
    now = db.utcnow()
    expires = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(timespec="seconds")
    sessions = []
    with db.connect() as conn:
        for index in range(8):
            course = f"Synthetic course {index}"
            published = index < 7
            conn.execute("INSERT INTO course_publication VALUES(?,?,?,?)", (course, int(published), "Synthetic SQL fixture", now))
            count = 30 if published else 1
            for lesson in range(count):
                vid = f"fixture-{index}-{lesson:03d}"
                conn.execute("INSERT INTO videos(id,path,course,title,bytes,mtime_ns,status,duration,created_at) VALUES(?,?,?,?,?,?,?,120,?)",
                             (vid, str(db.settings.courses_dir / course / f"{vid}.mp4"), course, f"[{lesson + 1:03d}] SQL lesson", 0, 1, "done", now))
                for chunk in range(3):
                    cid = f"{vid}-chunk-{chunk}"
                    text = "Synthetic inner join fixture content for retrieval"
                    conn.execute("INSERT INTO chunks VALUES(?,?,?,?,?,?,?)", (cid, vid, "speech", chunk * 30, (chunk + 1) * 30, text, None))
                    conn.execute("INSERT INTO chunk_fts VALUES(?,?)", (cid, text))
        for index in range(users):
            uid = f"synthetic-{index:05d}"
            token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            conn.execute("INSERT INTO users VALUES(?,?,?,?,?,1,0,?)", (uid, uid + "@fixture.invalid", uid, "disabled-synthetic-login", "student", now))
            conn.execute("INSERT INTO auth_sessions VALUES(?,?,?,?,?,?,?,?,?)",
                         (uid, uid, hashlib.sha256(token.encode()).hexdigest(), csrf, now, expires, now, "Synthetic baseline", "127.0.0.1"))
            for course_index in range(7):
                conn.execute("INSERT INTO enrollments VALUES(?,?,?)", (uid, f"Synthetic course {course_index}", now))
            sessions.append({"token": token, "csrf": csrf})
    # Session values exist only in the disposable fixture and are never in evidence.
    (directory / "sessions.json").write_text(json.dumps(sessions))
    (directory / "sessions.json").chmod(0o600)


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return round(ordered[max(0, math.ceil(fraction * len(ordered)) - 1)], 3) if ordered else 0.0


def process_sample(pid: int) -> dict:
    try:
        # Linux /proc statistics are observations, not attributed profiles.
        status = Path(f"/proc/{pid}/status").read_text().splitlines()
        memory = {line.split(":")[0]: int(line.split()[1]) for line in status if line.startswith(("VmRSS:", "VmHWM:", "Threads:"))}
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        ticks = os.sysconf("SC_CLK_TCK")
        io = {line.split(":")[0]: int(line.split()[1]) for line in Path(f"/proc/{pid}/io").read_text().splitlines()}
        return {"rss_kib": memory.get("VmRSS"), "high_water_rss_kib": memory.get("VmHWM"),
                "threads": memory.get("Threads"), "cpu_seconds": (int(fields[11]) + int(fields[12])) / ticks,
                "read_bytes": io.get("read_bytes"), "write_bytes": io.get("write_bytes")}
    except (OSError, ValueError, IndexError):
        return {"unavailable": True}


async def exercise(base: str, sessions: list[dict], rounds: int, pid: int) -> dict:
    durations = defaultdict(list)
    statuses = defaultdict(Counter)
    failures = []
    expected_denials = 0
    samples = []
    monitoring = True

    async def monitor():
        while monitoring:
            samples.append(process_sample(pid))
            await asyncio.sleep(0.1)

    async with httpx.AsyncClient(base_url=base, timeout=30, trust_env=False,
                                 limits=httpx.Limits(max_connections=len(sessions), max_keepalive_connections=len(sessions))) as client:
        async def request(method, path, session, expected=200, *, route=None, validate=None, **kwargs):
            nonlocal expected_denials
            key = method + " " + (route or path)
            started = time.perf_counter()
            try:
                response = await client.request(method, path, headers={"Cookie": "cf_session=" + session["token"], "X-CSRF-Token": session["csrf"]}, **kwargs)
            except httpx.HTTPError as exc:
                statuses[key]["client_error"] += 1
                failures.append({"route": key, "reason": type(exc).__name__})
                return {}
            finally:
                durations[key].append((time.perf_counter() - started) * 1000)
            try:
                statuses[key][str(response.status_code)] += 1
                if response.status_code != expected:
                    failures.append({"route": key, "expected": expected, "status": response.status_code})
                    return {}
                if expected in {401, 403, 404}:
                    expected_denials += 1
                payload = response.json() if response.content else {}
                if validate is not None and not validate(payload):
                    failures.append({"route": key, "reason": "semantic assertion failed"})
                return payload
            except (ValueError, KeyError, TypeError) as exc:
                failures.append({"route": key, "reason": type(exc).__name__})
                return {}

        async def learner(index, session):
            vid = "fixture-0-000"
            opened = await request("POST", f"/api/videos/{vid}/activity-session", session, 201,
                                   route="/api/videos/{video_id}/activity-session", json={})
            if "id" not in opened:
                return
            for sequence in range(1, rounds + 1):
                await request("GET", "/api/videos", session, validate=lambda p: len(p.get("videos", [])) == 210 and all(v["course"] != "Synthetic course 7" for v in p["videos"]))
                await request("GET", "/api/progress", session, validate=lambda p: len(p.get("progress", [])) == 210)
                await request("GET", "/api/me/learning", session)
                await request("GET", "/api/search?q=inner", session, route="/api/search", validate=lambda p: bool(p.get("results")))
                await request("POST", "/api/activity/" + opened["id"] + "/heartbeat", session,
                              route="/api/activity/{sid}/heartbeat", json={"sequence": sequence, "visible": True, "elapsed_seconds": 1},
                              validate=lambda p: p.get("accepted") is True and p.get("basis") == "visible_lesson_activity")
            percent = 10 + index % 20
            await request("PUT", f"/api/videos/{vid}/progress", session, route="/api/videos/{video_id}/progress", json={"percent": percent, "position": index % 120})
            await request("GET", "/api/progress", session, validate=lambda p: next((v["percent"] for v in p.get("progress", []) if v["video_id"] == vid), None) == percent)
            note = f"Synthetic learner {index} private note"
            await request("POST", f"/api/videos/{vid}/notes", session, 201, route="/api/videos/{video_id}/notes", json={"content": note, "position": 0})
            await request("GET", f"/api/videos/{vid}/notes", session, route="/api/videos/{video_id}/notes", validate=lambda p: len(p.get("notes", [])) == 1 and p["notes"][0]["content"] == note)
            await request("GET", "/api/admin/overview", session, 403)
            await request("GET", "/api/videos/fixture-7-000", session, 403, route="/api/videos/{video_id}")

        monitor_task = asyncio.create_task(monitor())
        before = process_sample(pid)
        started = time.perf_counter()
        try:
            await asyncio.gather(*(learner(index, session) for index, session in enumerate(sessions)))
        finally:
            elapsed = time.perf_counter() - started
            monitoring = False
            await monitor_task
        after = process_sample(pid)
    all_durations = [value for values in durations.values() for value in values]
    routes = {key: {"requests": len(values), "status_counts": dict(statuses[key]),
                    "p50_ms": percentile(values, .50), "p95_ms": percentile(values, .95), "p99_ms": percentile(values, .99), "max_ms": round(max(values), 3)}
              for key, values in sorted(durations.items())}
    return {"authenticated_sessions": len(sessions), "rounds_per_session": rounds,
            "load_model": "closed sessions, sequential requests per learner, no think time, one same-host load generator",
            "requests_attempted": len(all_durations), "expected_requests": len(sessions) * (5 * rounds + 7),
            "elapsed_seconds": round(elapsed, 3), "completed_requests_per_second": round(sum(sum(c.values()) - c.get("client_error", 0) for c in statuses.values()) / elapsed, 3),
            "p50_ms": percentile(all_durations, .50), "p95_ms": percentile(all_durations, .95), "p99_ms": percentile(all_durations, .99),
            "expected_authorization_denials": expected_denials, "unexpected_failures": len(failures), "failure_samples": failures[:1000],
            "routes": routes, "server_resource_observations": {"before": before, "after": after,
                "peak_sampled_rss_kib": max((sample.get("rss_kib") or 0 for sample in samples), default=0),
                "peak_sampled_threads": max((sample.get("threads") or 0 for sample in samples), default=0),
                "sample_interval_seconds": .1, "samples": len(samples)}}


def hardware() -> dict:
    cpu = "unknown"
    try:
        cpu = next(line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines() if line.startswith("model name"))
    except (OSError, StopIteration):
        pass
    values = {"platform": platform.platform(), "python": platform.python_version(), "cpu_model": cpu,
              "logical_cpus": os.cpu_count(), "affinity_cpus": len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None,
              "physical_memory_bytes": os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")}
    for key, path in (("cgroup_cpu_max", "/sys/fs/cgroup/cpu.max"), ("cgroup_memory_max", "/sys/fs/cgroup/memory.max")):
        try:
            values[key] = Path(path).read_text().strip()
        except OSError:
            values[key] = "unavailable"
    return values


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--users", type=int, default=50)
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--output", type=Path, default=ROOT / "docs/rewrite/M0_BASELINE.json")
    parser.add_argument("--seed-directory", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not 1 <= args.users <= 500 or not 1 <= args.rounds <= 20:
        parser.error("Use 1–500 synthetic sessions and 1–20 rounds; full capacity needs the separate contract")
    if args.seed_directory is not None:
        seed(args.seed_directory, args.users)
        return
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    dirty = subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).splitlines()
    source_hashes = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                     for path in sorted((ROOT / "app").glob("*.py")) if not path.name.startswith("._")}
    with tempfile.TemporaryDirectory(prefix="courseforge-rewrite-baseline-") as temporary:
        directory = Path(temporary)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        env = synthetic_environment(directory, base)
        subprocess.run([sys.executable, str(Path(__file__).resolve()), "--seed-directory", str(directory), "--users", str(args.users)],
                       cwd=ROOT, env=env, check=True, capture_output=True, text=True)
        sessions = json.loads((directory / "sessions.json").read_text())
        with (directory / "server.log").open("w") as log:
            process = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port), "--workers", "1", "--no-access-log"],
                                       cwd=ROOT, env=env, stdout=log, stderr=log)
            try:
                for _ in range(150):
                    if process.poll() is not None:
                        raise RuntimeError("Isolated baseline process exited before readiness")
                    try:
                        if httpx.get(base + "/api/health", timeout=.5, trust_env=False).status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(.1)
                else:
                    raise RuntimeError("Isolated baseline process did not become ready")
                result = asyncio.run(exercise(base, sessions, args.rounds, process.pid))
                with sqlite3.connect(directory / "data/courseforge.sqlite3") as conn:
                    counts = {table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in
                              ("users", "auth_sessions", "videos", "chunks", "enrollments", "video_progress", "video_notes", "activity_sessions")}
                    integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
                    foreign_keys = conn.execute("PRAGMA foreign_key_check").fetchall()
                    sqlite_config = {name: conn.execute("PRAGMA " + name).fetchone()[0] for name in ("journal_mode", "synchronous")}
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        report = {"schema_version": 1, "measured_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                  "revision": revision, "dirty_tree": bool(dirty), "dirty_paths_before_run": dirty,
                  "application_source_sha256": source_hashes,
                  "dependencies": {name: version(name) for name in ("fastapi", "starlette", "uvicorn", "httpx", "argon2-cffi")},
                  "hardware": hardware(), "server": {"entrypoint": "uvicorn app.main:app", "workers": 1, "transport": "plain loopback HTTP", "keepalive": "uvicorn default"},
                  "fixture": {"source": "fresh generated database; no configured library/database read", "published_courses": 7, "unpublished_courses": 1, "lessons_visible_to_each_learner": 210,
                              "login": "preseeded synthetic sessions; password login intentionally excluded", "record_counts_after_run": counts,
                              "sqlite_integrity": integrity, "sqlite_foreign_key_violations": foreign_keys, "sqlite_default_connection_config": sqlite_config},
                  "api": result, "media": {"verdict": "not measured", "reason": "No bytes, decoding or Odysee requests in this API baseline"},
                  "ai_jobs": {"verdict": "not measured", "reason": "No inference, indexing or lab execution in this API baseline"},
                  "limitations": ["Shared host and load generator; other agents/processes can affect timing.", "Closed finite workload is not sustained/open-arrival capacity evidence.",
                                  "Plain loopback HTTP excludes TLS and network geography.", "No sign-in/hash burst, media, browser, mail, AI, labs, failover, or growth-fixture measurement.",
                                  "No SQL query timing/lock-wait profile or browser first-frame metrics; these remain M0/M4 work.",
                                  "Linux /proc resource counters can be virtualized or omit IO under this execution environment; they are observational only.",
                                  "No extrapolation to 10,000 learners or language-only speed attribution."],
                  "reproduction": f".venv/bin/python scripts/rewrite_baseline.py --users {args.users} --rounds {args.rounds} --output docs/rewrite/M0_BASELINE.json"}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        print(json.dumps({"output": str(args.output), "requests": result["requests_attempted"], "rps": result["completed_requests_per_second"],
                          "p95_ms": result["p95_ms"], "unexpected_failures": result["unexpected_failures"], "integrity": integrity}))
        if result["unexpected_failures"] or result["requests_attempted"] != result["expected_requests"] or integrity != "ok" or foreign_keys:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
