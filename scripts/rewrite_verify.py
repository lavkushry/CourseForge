#!/usr/bin/env python3
"""Verify documented Go API behavior over HTTP with disposable synthetic users.

Reads no application source and performs no provider/load-test traffic. Credentials
are supplied through CF_VERIFY_* environment variables and never enter reports.
The target must explicitly be an isolated development fixture on loopback.
"""
from __future__ import annotations

import argparse
import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import time
from urllib.parse import urlsplit

import httpx

ROOT = Path(__file__).resolve().parents[1]
CASES: list[dict] = []


def client(base: str) -> httpx.Client:
    origin = os.environ.get("CF_VERIFY_ORIGIN", base)
    return httpx.Client(base_url=base, timeout=10, trust_env=False, headers={"Origin": origin, "User-Agent": "CourseForge-isolated-contract-validator"})


def check(name: str, clause: str, c: httpx.Client, method: str, path: str, expected=(200,), validate=None, **kwargs) -> tuple[dict, httpx.Response | None]:
    started = time.perf_counter()
    entry = {"case": name, "clause": clause, "method": method, "path": path, "expected_status": list(expected)}
    try:
        response = c.request(method, path, **kwargs)
        try:
            payload = response.json() if response.content else {}
        except ValueError:
            payload = {}
        entry["observed_status"] = response.status_code
        entry["response_keys"] = sorted(payload) if isinstance(payload, dict) else ["array"]
        entry["status"] = "pass" if response.status_code in expected and (validate is None or validate(payload, response)) else "fail"
        entry["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 3)
        CASES.append(entry)
        return payload, response
    except (httpx.HTTPError, KeyError, TypeError, ValueError, AttributeError, IndexError) as exc:
        entry.update(status="fail", error_type=type(exc).__name__, elapsed_ms=round((time.perf_counter() - started) * 1000, 3))
        CASES.append(entry)
        return {}, None


def local_target(base: str) -> str:
    parsed = urlsplit(base)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or parsed.username or parsed.password or parsed.path not in {"", "/"}:
        raise SystemExit("This verifier only mutates an explicitly isolated HTTP loopback fixture")
    return base.rstrip("/")


def item(payload: dict, key: str) -> dict:
    value = payload.get(key, payload)
    return value if isinstance(value, dict) else {}


def get_progress(payload: dict, lesson: str) -> dict:
    value = payload.get("progress", {})
    if isinstance(value, dict):
        return value
    if isinstance(value, list):
        return next((row for row in value if row.get("lesson_id", row.get("video_id")) == lesson), {})
    return {}


def login(c: httpx.Client, prefix: str, email: str, password: str, name: str) -> dict:
    payload, response = check(name + " login", "M1-01", c, "POST", prefix + "/auth/login", json={"email": email, "password": password},
                              validate=lambda p, r: bool(p.get("csrf_token")) and p.get("user", {}).get("email") == email and "password_hash" not in p.get("user", {}) and
                              "httponly" in r.headers.get("set-cookie", "").lower() and "samesite=lax" in r.headers.get("set-cookie", "").lower())
    if response is not None and response.status_code == 200 and payload.get("csrf_token"):
        c.headers["X-CSRF-Token"] = payload["csrf_token"]
    return payload.get("user", {})


def run(args) -> dict:
    base = local_target(args.base)
    replicas = [local_target(value) for value in args.replica]
    prefix = args.prefix.rstrip("/")
    course = args.course
    lesson = args.lesson
    password = os.environ.get("CF_VERIFY_PASSWORD")
    if not password:
        raise SystemExit("Set CF_VERIFY_PASSWORD to an isolated fixture password")
    suffix = secrets.token_hex(6)
    emails = {name: f"contract-{name}-{suffix}@fixture.test" for name in ("alice", "bob")}
    users = {}
    clients = [client(base) for _ in range(5)]
    guest, alice, bob, fresh, admin = clients
    checkpoint_note_id = None
    try:
        check("liveness", "M1-10", guest, "GET", "/health/live")
        check("readiness", "M1-10", guest, "GET", "/health/ready")
        for route in ("/me", "/progress", f"/lessons/{lesson}"):
            check("guest denied " + route, "M1-02", guest, "GET", prefix + route, (401,))
        check("hostile login origin", "M1-03", guest, "POST", prefix + "/auth/login", (403,),
              headers={"Origin": "https://hostile.fixture.invalid"}, json={"email": "unknown@fixture.test", "password": password})
        for name, c in (("alice", alice), ("bob", bob)):
            registered, _ = check(name + " registration", "M1-02", c, "POST", prefix + "/auth/register", (args.registration_status,),
                                  json={"email": emails[name], "name": "Synthetic " + name, "password": password})
            if registered.get("csrf_token"):
                c.headers["X-CSRF-Token"] = registered["csrf_token"]
            users[name] = login(c, prefix, emails[name], password, name)
        check("wrong password rejected", "M1-01", guest, "POST", prefix + "/auth/login", (401,), json={"email": emails["alice"], "password": password + "wrong"})
        check("unknown email rejected", "M1-01", guest, "POST", prefix + "/auth/login", (401,), json={"email": "unknown-" + suffix + "@fixture.test", "password": password})
        check("unenrolled lesson denied", "M1-04", alice, "GET", prefix + f"/lessons/{lesson}", (403, 404))
        for name, overrides in (("missing", {"X-CSRF-Token": ""}), ("wrong", {"X-CSRF-Token": "wrong"}), ("hostile origin", {"Origin": "https://hostile.fixture.invalid"})):
            check(name + " CSRF enrollment denied", "M1-03", alice, "POST", prefix + f"/courses/{course}/enroll", (403,), headers=overrides, json={})
        check("rejected enrollment unchanged", "M1-03", alice, "GET", prefix + f"/lessons/{lesson}", (403, 404))
        check("unpublished enrollment denied", "M1-04", alice, "POST", prefix + "/courses/fixture-unpublished/enroll", (403, 404), json={})
        check("unpublished lesson denied", "M1-04", alice, "GET", prefix + "/lessons/fixture-unpublished-lesson", (403, 404))
        check("different unenrolled published lesson denied", "M1-04", alice, "GET", prefix + "/lessons/fixture-other-lesson", (403, 404))
        check("Bob enrolls second published course", "M1-04", bob, "POST", prefix + "/courses/fixture-other/enroll", (200, 201), json={})
        check("Bob opens second permitted lesson", "M1-04", bob, "GET", prefix + "/lessons/fixture-other-lesson")
        for name, c in (("alice", alice), ("bob", bob)):
            check(name + " enrollment", "M1-04", c, "POST", prefix + f"/courses/{course}/enroll", (200, 201), json={})
            check(name + " duplicate enrollment", "M1-04", c, "POST", prefix + f"/courses/{course}/enroll", (200, 201), json={})
            check(name + " permitted lesson", "M1-04", c, "GET", prefix + f"/lessons/{lesson}", validate=lambda p, _r: item(p, "lesson").get("id") == lesson)
        check("course has stable lessons", "M1-04", alice, "GET", prefix + f"/courses/{course}", validate=lambda p, _r: any(row.get("id") == lesson for row in p.get("lessons", [])))
        check("public catalog exposes published fixtures only", "M1-04", guest, "GET", prefix + "/public/courses",
              validate=lambda p, _r: {course, "fixture-other"}.issubset({row.get("id") for row in p.get("courses", [])}) and all(row.get("id") != "fixture-unpublished" for row in p.get("courses", [])))
        check("public course preview retains course identity", "M1-04", guest, "GET", prefix + "/public/courses/" + course, validate=lambda p, _r: item(p, "course").get("id") == course)
        check("unpublished public preview denied", "M1-04", guest, "GET", prefix + "/public/courses/fixture-unpublished", (404,))
        check("private catalog only Alice enrollment", "M1-04", alice, "GET", prefix + "/courses", validate=lambda p, _r: {row.get("id") for row in p.get("courses", [])} == {course})
        check("private catalog only Bob enrollments", "M1-04", bob, "GET", prefix + "/courses", validate=lambda p, _r: {row.get("id") for row in p.get("courses", [])} == {course, "fixture-other"})
        check("catalog bounded page", "M1-08", alice, "GET", prefix + "/courses?limit=1", validate=lambda p, _r: len(p.get("courses", [])) <= 1)
        page_one, _ = check("Bob first catalog page", "M1-04", bob, "GET", prefix + "/courses?limit=1", validate=lambda p, _r: len(p.get("courses", [])) == 1 and bool(p.get("next_cursor")))
        if page_one.get("next_cursor"):
            first_ids = {row.get("id") for row in page_one.get("courses", [])}
            check("Bob next page is distinct and authorized", "M1-04", bob, "GET", prefix + "/courses", params={"limit": 1, "cursor": page_one["next_cursor"]},
                  validate=lambda p, _r: len(p.get("courses", [])) == 1 and not first_ids.intersection(row.get("id") for row in p["courses"]) and first_ids.union(row.get("id") for row in p["courses"]) == {course, "fixture-other"})
        check("excessive catalog page rejected", "M1-08", alice, "GET", prefix + "/courses?limit=1000000", (400, 422))

        progress_path = prefix + f"/lessons/{lesson}/progress"
        check("missing progress CSRF", "M1-03", alice, "PUT", progress_path, (403,), headers={"X-CSRF-Token": ""}, json={"percent": 99, "position": 99})
        first_progress, _ = check("save Alice private progress", "M1-05", alice, "PUT", progress_path, json={"percent": 33, "position": 20})
        check("Alice progress persisted", "M1-05", alice, "GET", prefix + f"/lessons/{lesson}", validate=lambda p, _r: get_progress(p, lesson).get("percent") == 33 and get_progress(p, lesson).get("position") == 20)
        check("Bob progress separate", "M1-05", bob, "GET", prefix + f"/lessons/{lesson}", validate=lambda p, _r: get_progress(p, lesson).get("percent", 0) == 0 and get_progress(p, lesson).get("position", 0) == 0)
        for name, data in (("percent above range", {"percent": 101, "position": 20}), ("negative position", {"percent": 33, "position": -1}), ("beyond known duration", {"percent": 33, "position": 1000000})):
            check(name, "M1-08", alice, "PUT", progress_path, (400, 422), json=data)
        check("nonfinite progress rejected", "M1-08", alice, "PUT", progress_path, (400, 422), content='{"percent":33,"position":NaN}', headers={"Content-Type": "application/json"})
        check("invalid progress unchanged", "M1-05", alice, "GET", prefix + f"/lessons/{lesson}", validate=lambda p, _r: get_progress(p, lesson).get("percent") == 33 and get_progress(p, lesson).get("position") == 20)
        revision = first_progress.get("revision")
        if isinstance(revision, int):
            check("stale progress revision denied", "M1-05", alice, "PUT", progress_path, (409,), json={"percent": 99, "position": 20, "expected_revision": revision - 1})
            current, _ = check("read progress before competing writes", "M1-09", alice, "GET", prefix + f"/lessons/{lesson}")
            current_revision = get_progress(current, lesson).get("revision")
            with ThreadPoolExecutor(max_workers=2) as pool:
                pending_writes = [pool.submit(check, "competing conditional write " + str(value), "M1-09", alice, "PUT", progress_path, (200, 409),
                                             json={"percent": value, "position": 20, "expected_revision": current_revision}) for value in (44, 45)]
                outcomes = [future.result() for future in pending_writes]
            statuses = sorted(response.status_code for _payload, response in outcomes if response is not None)
            CASES.append({"case": "exactly one competing conditional write commits", "clause": "M1-09", "status": "pass" if statuses == [200, 409] else "fail", "observed_statuses": statuses})
            check("restore Alice progress after concurrency probe", "M1-05", alice, "PUT", progress_path, json={"percent": 33, "position": 20})
            check("Bob unaffected by competing Alice writes", "M1-09", bob, "GET", prefix + f"/lessons/{lesson}", validate=lambda p, _r: get_progress(p, lesson).get("percent", 0) == 0)
        complete_body = {"percent": 100, "position": 0}
        check("explicit completion saved", "M1-05", alice, "PUT", progress_path, json=complete_body)
        check("repeated explicit completion write", "M1-05", alice, "PUT", progress_path, json=complete_body)
        check("manual resume saved", "M1-05", alice, "PUT", prefix + f"/lessons/{lesson}/resume-point", json={"position": 10})
        check("manual resume preserves explicit completion", "M1-05", alice, "GET", prefix + f"/lessons/{lesson}",
              validate=lambda p, _r: get_progress(p, lesson).get("completed") is True and get_progress(p, lesson).get("explicit_completed") is True and get_progress(p, lesson).get("position") == 10)
        check("invalid manual resume rejected", "M1-08", alice, "PUT", prefix + f"/lessons/{lesson}/resume-point", (400, 422), json={"position": 1000000})
        check("restore isolated progress after completion probes", "M1-05", alice, "PUT", progress_path, json={"percent": 33, "position": 20})

        notes_path = prefix + f"/lessons/{lesson}/notes"
        note_body = {"position": 12, "content": "Synthetic private note " + suffix}
        note_key = "contract-note-" + suffix
        check("missing note CSRF denied", "M1-03", alice, "POST", notes_path, (403,), headers={"X-CSRF-Token": "", "Idempotency-Key": note_key}, json=note_body)
        created, _ = check("Alice note created", "M1-06", alice, "POST", notes_path, (201,), headers={"Idempotency-Key": note_key}, json=note_body)
        note_id = item(created, "note").get("id")
        check("same note retry is idempotent", "M1-06", alice, "POST", notes_path, (200, 201), headers={"Idempotency-Key": note_key}, json=note_body,
              validate=lambda p, _r: item(p, "note").get("id") == note_id and bool(note_id))
        check("Alice note persisted once", "M1-06", alice, "GET", notes_path,
              validate=lambda p, _r: len(p.get("notes", [])) == 1 and p["notes"][0].get("id") == note_id and p["notes"][0].get("content") == note_body["content"])
        check("Bob cannot read Alice note", "M1-06", bob, "GET", notes_path, validate=lambda p, _r: p.get("notes") == [])
        if note_id:
            check("Bob cannot delete Alice note", "M1-06", bob, "DELETE", notes_path + "/" + note_id, (404,))
        else:
            CASES.append({"case": "Bob cannot delete Alice note", "clause": "M1-06", "status": "fail", "error_type": "MissingNoteID"})
        check("blank note rejected", "M1-08", alice, "POST", notes_path, (400, 422), headers={"Idempotency-Key": "blank-" + suffix}, json={"position": 0, "content": "   "})
        check("unknown note field rejected", "M1-08", alice, "POST", notes_path, (400, 422), headers={"Idempotency-Key": "unknown-" + suffix}, json={"position": 0, "content": "Synthetic unused note", "user_id": users.get("bob", {}).get("id", "other")})
        check("oversized body rejected", "M1-08", alice, "POST", notes_path, (400, 413, 422), headers={"Idempotency-Key": "large-" + suffix}, json={"position": 0, "content": "x" * (2 ** 21)})
        fresh_user = login(fresh, prefix, emails["alice"], password, "fresh Alice session")
        check("fresh session reads durable progress", "M1-09", fresh, "GET", prefix + f"/lessons/{lesson}", validate=lambda p, _r: get_progress(p, lesson).get("percent") == 33)
        check("fresh session reads durable note", "M1-09", fresh, "GET", notes_path, validate=lambda p, _r: any(row.get("id") == note_id for row in p.get("notes", [])))

        old_cookies = [copy.copy(cookie) for cookie in fresh.cookies.jar]
        CASES.append({"case": "authenticated session cookie captured for replay", "clause": "M1-01", "status": "pass" if old_cookies else "fail", "cookie_count": len(old_cookies)})
        check("logout wrong CSRF denied", "M1-03", fresh, "POST", prefix + "/auth/logout", (403,), headers={"X-CSRF-Token": ""}, json={})
        check("correct logout", "M1-07", fresh, "POST", prefix + "/auth/logout", (200, 204), json={})
        for cookie in old_cookies:
            fresh.cookies.jar.set_cookie(copy.copy(cookie))
        check("revoked cookie denied", "M1-07", fresh, "GET", prefix + "/me", (401,))
        for target in replicas:
            with client(target) as replica_client:
                for cookie in old_cookies:
                    replica_client.cookies.jar.set_cookie(copy.copy(cookie))
                check("revoked cookie denied replica " + target, "M1-07", replica_client, "GET", prefix + "/me", (401,))
        if note_id:
            check("note deletion without CSRF denied", "M1-03", alice, "DELETE", notes_path + "/" + note_id, (403,), headers={"X-CSRF-Token": ""})
            check("rejected deletion preserves note", "M1-03", alice, "GET", notes_path, validate=lambda p, _r: any(row.get("id") == note_id for row in p.get("notes", [])))
            check("Alice deletes own note", "M1-06", alice, "DELETE", notes_path + "/" + note_id, (200, 204))
            check("note deletion durable", "M1-06", alice, "GET", notes_path, validate=lambda p, _r: p.get("notes") == [])

        admin_email = os.environ.get("CF_VERIFY_ADMIN_EMAIL")
        admin_password = os.environ.get("CF_VERIFY_ADMIN_PASSWORD", password)
        if admin_email:
            admin_user = login(admin, prefix, admin_email, admin_password, "fixture administrator")
            uid = fresh_user.get("id")
            if uid:
                check("student cannot revoke another user", "M1-02", bob, "DELETE", prefix + f"/admin/users/{uid}/sessions", (403,))
                check("admin revokes Alice sessions", "M1-07", admin, "DELETE", prefix + f"/admin/users/{uid}/sessions", (200, 204))
                check("Alice session revoked by admin", "M1-07", alice, "GET", prefix + "/me", (401,))
                for target in replicas:
                    with client(target) as replica_client:
                        for cookie in alice.cookies.jar:
                            replica_client.cookies.jar.set_cookie(copy.copy(cookie))
                        check("admin session revoke visible on replica " + target, "M1-07", replica_client, "GET", prefix + "/me", (401,))
                alice.cookies.clear()
                alice.headers.pop("X-CSRF-Token", None)
                login(alice, prefix, emails["alice"], password, "Alice after admin session revoke")
                enrollment_path = prefix + f"/admin/users/{uid}/enrollments"
                check("admin removes Alice enrollment", "M1-07", admin, "PUT", enrollment_path, json={"course": course, "enrolled": False})
                check("removed enrollment denies lesson", "M1-07", alice, "GET", prefix + f"/lessons/{lesson}", (403, 404))
                check("removed enrollment denies notes", "M1-06", alice, "GET", notes_path, (403, 404))
                for target in replicas:
                    with client(target) as replica_client:
                        for cookie in alice.cookies.jar:
                            replica_client.cookies.jar.set_cookie(copy.copy(cookie))
                        check("enrollment revoke visible on replica " + target, "M1-07", replica_client, "GET", prefix + f"/lessons/{lesson}", (403, 404))
                check("admin restores synthetic enrollment", "M1-07", admin, "PUT", enrollment_path, json={"course": course, "enrolled": True})
                check("restored enrollment permits lesson", "M1-07", alice, "GET", prefix + f"/lessons/{lesson}")
                user_path = prefix + f"/admin/users/{uid}"
                check("admin suspends Alice", "M1-02", admin, "PATCH", user_path, json={"suspended": True})
                check("suspended cookie denied", "M1-02", alice, "GET", prefix + "/me", (401, 403))
                check("suspended password login denied", "M1-02", guest, "POST", prefix + "/auth/login", (401, 403), json={"email": emails["alice"], "password": password})
                for target in replicas:
                    with client(target) as replica_client:
                        for cookie in alice.cookies.jar:
                            replica_client.cookies.jar.set_cookie(copy.copy(cookie))
                        check("suspension visible on replica " + target, "M1-07", replica_client, "GET", prefix + "/me", (401, 403))
                check("admin restores synthetic account", "M1-02", admin, "PATCH", user_path, json={"suspended": False})
                alice.cookies.clear()
                alice.headers.pop("X-CSRF-Token", None)
                login(alice, prefix, emails["alice"], password, "Alice after unsuspension")
                if admin_user.get("id"):
                    check("last administrator cannot be demoted", "M1-07", admin, "PUT", prefix + f"/admin/users/{admin_user['id']}/role", (403, 409), json={"role": "student", "current_password": admin_password})
                role_path = prefix + f"/admin/users/{uid}/role"
                if users.get("bob", {}).get("id"):
                    check("student cannot grant their own admin role", "M1-02", bob, "PUT", prefix + f"/admin/users/{users['bob']['id']}/role", (403,), json={"role": "admin", "current_password": password})
                check("role change requires administrator password", "M1-02", admin, "PUT", role_path, (403,), json={"role": "admin", "current_password": admin_password + "wrong"})
                check("admin temporarily changes Alice role", "M1-07", admin, "PUT", role_path, json={"role": "admin", "current_password": admin_password})
                check("role change revokes Alice session", "M1-07", alice, "GET", prefix + "/me", (401,))
                for target in replicas:
                    with client(target) as replica_client:
                        for cookie in alice.cookies.jar:
                            replica_client.cookies.jar.set_cookie(copy.copy(cookie))
                        check("role revoke visible on replica " + target, "M1-07", replica_client, "GET", prefix + "/me", (401,))
                check("admin restores synthetic student role", "M1-07", admin, "PUT", role_path, json={"role": "student", "current_password": admin_password})
        unverified_email = os.environ.get("CF_VERIFY_UNVERIFIED_EMAIL")
        if unverified_email:
            with client(base) as unverified:
                unverified_payload, unverified_response = check("unverified fixture login", "M1-02", unverified, "POST", prefix + "/auth/login", (200, 401, 403),
                                                               json={"email": unverified_email, "password": password})
                if unverified_response is not None and unverified_response.status_code == 200:
                    unverified.headers["X-CSRF-Token"] = unverified_payload.get("csrf_token", "")
                    check("unverified account cannot enroll", "M1-02", unverified, "POST", prefix + f"/courses/{course}/enroll", (403,), json={})
                    check("unverified account cannot open lesson", "M1-02", unverified, "GET", prefix + f"/lessons/{lesson}", (403, 404))
        check("save Bob restart checkpoint progress", "M1-09", bob, "PUT", progress_path, json={"percent": 61, "position": 30})
        checkpoint, _ = check("save Bob restart checkpoint note", "M1-09", bob, "POST", notes_path, (201,),
                              headers={"Idempotency-Key": "checkpoint-" + suffix}, json={"position": 30, "content": "Synthetic restart checkpoint " + suffix})
        checkpoint_note_id = item(checkpoint, "note").get("id")
        check("read committed restart checkpoint", "M1-09", bob, "GET", notes_path,
              validate=lambda p, _r: any(row.get("id") == checkpoint_note_id for row in p.get("notes", [])) and bool(checkpoint_note_id))
    finally:
        for c in clients:
            c.close()
    pending = {
        "M1-01": ["Secure cookie in production HTTPS configuration; migrated legacy password hashes"],
        "M1-02": ([] if admin_email else ["suspended fixture and admin role controls"]) + ([] if unverified_email else ["unverified account state"]),
        "M1-03": [],
        "M1-04": [],
        "M1-05": ["duplicate completion credit in aggregate/event accounting"] + ([] if isinstance(revision, int) else ["stale revision conflicts"]),
        "M1-06": [],
        "M1-07": ([] if admin_email else ["administrative account/enrollment/role revocation and last-admin protection"]) + ([] if replicas else ["two API replicas"]),
        "M1-08": ["dependency deadline and overload admission/recovery; real password-hash resource budget"],
        "M1-09": ["actual API/PostgreSQL restart/crash and acknowledged-state comparison"] + ([] if isinstance(revision, int) else ["concurrent HTTP writes"]),
        "M1-10": ["dependency readiness failure, graceful shutdown and redacted operator metrics/logs"],
    }
    clauses = {}
    for clause, missing in pending.items():
        relevant = [case for case in CASES if case["clause"] == clause]
        clauses[clause] = {"status": "fail" if any(case["status"] == "fail" for case in relevant) else "pending" if missing else "pass",
                           "passed_cases": sum(case["status"] == "pass" for case in relevant), "failed_cases": sum(case["status"] == "fail" for case in relevant), "unverified_requirements": missing}
    return {"schema_version": 1, "measured_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "target": base, "replicas": replicas, "contract": "docs/rewrite/M1_CONTRACT.md", "api_prefix": prefix,
            "origin": os.environ.get("CF_VERIFY_ORIGIN", base),
            "route_binding": {"registration_status": args.registration_status, "canonical_registration_status": 201, "unauthorized_lesson_status": "403 or404; v1 may hide unauthorized IDs"},
            "fixture": {"course_id": course, "lesson_id": lesson, "new_synthetic_accounts": 2, "unique_namespace": suffix, "seed": "coordinator cmd/seed in isolated courseforge_rewrite PostgreSQL"},
            "restart_checkpoint": {"note_id": checkpoint_note_id, "percent": 61, "position": 30, "user": "bob", "writes_acknowledged": bool(checkpoint_note_id)},
            "method": "HTTP behavior checks against prewritten contract; Go implementation source not inspected",
            "cases": CASES, "clauses": clauses, "summary": {"pass": sum(case["status"] == "pass" for case in CASES), "fail": sum(case["status"] == "fail" for case in CASES)},
            "scope": "Finite correctness probes; no browser/media/AI throughput or 10k capacity conclusion",
            "remaining": ["M2 playback/browser/media clauses independently pending", "Full M3–M5 feature parity/migration/recovery/capacity/release remain required"]}


def verify_restart(args) -> dict:
    prior = json.loads(args.restart_report.read_text())
    base = local_target(args.base)
    fixture = prior["fixture"]
    checkpoint = prior["restart_checkpoint"]
    password = os.environ.get("CF_VERIFY_PASSWORD")
    if not password or not checkpoint.get("writes_acknowledged"):
        raise SystemExit("An acknowledged checkpoint report and CF_VERIFY_PASSWORD are required")
    prefix = args.prefix.rstrip("/")
    namespace = fixture["unique_namespace"]
    email = "contract-bob-" + namespace + "@fixture.test"
    with client(base) as c:
        login(c, prefix, email, password, "checkpoint owner after operator restart")
        lesson = fixture["lesson_id"]
        check("progress survives operator restart", "M1-09", c, "GET", prefix + "/lessons/" + lesson,
              validate=lambda p, _r: get_progress(p, lesson).get("percent") == checkpoint["percent"] and get_progress(p, lesson).get("position") == checkpoint["position"])
        check("note survives operator restart", "M1-09", c, "GET", prefix + "/lessons/" + lesson + "/notes",
              validate=lambda p, _r: any(row.get("id") == checkpoint["note_id"] and row.get("content") == "Synthetic restart checkpoint " + namespace for row in p.get("notes", [])))
        for replica in args.replica:
            target = local_target(replica)
            with client(target) as replica_client:
                for cookie in c.cookies.jar:
                    replica_client.cookies.jar.set_cookie(copy.copy(cookie))
                check("progress survives restart on replica " + target, "M1-09", replica_client, "GET", prefix + "/lessons/" + lesson,
                      validate=lambda p, _r: get_progress(p, lesson).get("percent") == checkpoint["percent"] and get_progress(p, lesson).get("position") == checkpoint["position"])
                check("note survives restart on replica " + target, "M1-09", replica_client, "GET", prefix + "/lessons/" + lesson + "/notes",
                      validate=lambda p, _r: any(row.get("id") == checkpoint["note_id"] and row.get("content") == "Synthetic restart checkpoint " + namespace for row in p.get("notes", [])))
    return {"schema_version": 1, "measured_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "target": base, "replicas": args.replica, "contract": "docs/rewrite/M1_CONTRACT.md", "phase": "checkpoint readback after sign-in and operator restart",
            "checkpoint_report": str(args.restart_report), "cases": CASES,
            "summary": {"pass": sum(case["status"] == "pass" for case in CASES), "fail": sum(case["status"] == "fail" for case in CASES)},
            "scope": "This phase reads previously acknowledged state. Coordinator must separately record the actual API/database restart event; this script does not stop shared services.",
            "remaining": ["storage-loss durability/failover remains outside this checkpoint", "concurrent-write and broader parity/capacity gates remain separate"]}


def verify_completion(args) -> dict:
    prior = json.loads(args.completion_report.read_text())
    base = local_target(args.base)
    fixture = prior["fixture"]
    password = os.environ.get("CF_VERIFY_PASSWORD")
    if not password:
        raise SystemExit("CF_VERIFY_PASSWORD is required")
    prefix = args.prefix.rstrip("/")
    email = "contract-alice-" + fixture["unique_namespace"] + "@fixture.test"
    lesson = fixture["lesson_id"]
    progress_path = prefix + "/lessons/" + lesson + "/progress"
    with client(base) as c:
        login(c, prefix, email, password, "completion binding owner")
        for name in ("explicit completion saved", "repeated explicit completion write"):
            check(name, "M1-05", c, "PUT", progress_path, json={"percent": 100, "position": 0})
        check("manual resume saved", "M1-05", c, "PUT", prefix + "/lessons/" + lesson + "/resume-point", json={"position": 10})
        check("manual resume preserves explicit completion", "M1-05", c, "GET", prefix + "/lessons/" + lesson,
              validate=lambda p, _r: get_progress(p, lesson).get("completed") is True and get_progress(p, lesson).get("explicit_completed") is True and get_progress(p, lesson).get("position") == 10)
        check("restore isolated progress after completion probes", "M1-05", c, "PUT", progress_path, json={"percent": 33, "position": 20})
        check("lower percent clears manual completion", "M1-05", c, "GET", prefix + "/lessons/" + lesson,
              validate=lambda p, _r: get_progress(p, lesson).get("completed") is False and get_progress(p, lesson).get("explicit_completed") is False and get_progress(p, lesson).get("percent") == 33 and get_progress(p, lesson).get("position") == 20)
        check("undocumented completed input rejected", "M1-08", c, "PUT", progress_path, (400, 422), json={"percent": 100, "position": 20, "completed": True})
        check("rejected completed field preserves stored progress", "M1-05", c, "GET", prefix + "/lessons/" + lesson,
              validate=lambda p, _r: get_progress(p, lesson).get("percent") == 33 and get_progress(p, lesson).get("position") == 20)
    return {"schema_version": 1, "measured_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "target": base, "contract": "docs/rewrite/M1_CONTRACT.md", "phase": "completion schema binding correction and nearby regressions",
            "prior_report": str(args.completion_report), "cases": CASES,
            "binding": {"request_fields": ["position", "percent", "expected_revision"], "completed_fields": "Response only; percent100 completes, lower percent clears manual completion, resume position preserves it"},
            "summary": {"pass": sum(case["status"] == "pass" for case in CASES), "fail": sum(case["status"] == "fail" for case in CASES)}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:18090")
    parser.add_argument("--replica", action="append", default=[])
    parser.add_argument("--prefix", default="/api/v1")
    parser.add_argument("--registration-status", type=int, choices=(200, 201), default=201, help="Use200 only for the coordinator-documented initial development binary; canonical v1 creation is201")
    parser.add_argument("--course", default="fixture-course")
    parser.add_argument("--lesson", default="fixture-lesson-1")
    parser.add_argument("--output", type=Path, default=ROOT / "docs/rewrite/M1_HTTP_BEHAVIOR.json")
    parser.add_argument("--restart-report", type=Path, help="Read an existing checkpoint after the coordinator records an isolated API/database restart; creates no new accounts")
    parser.add_argument("--completion-report", type=Path, help="Rerun completion binding and nearby regressions for an existing synthetic fixture; creates no new accounts")
    args = parser.parse_args()
    if args.restart_report and args.completion_report:
        parser.error("Choose one targeted verification phase")
    report = verify_restart(args) if args.restart_report else verify_completion(args) if args.completion_report else run(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"output": str(args.output), "summary": report["summary"], "clauses": {key: value["status"] for key, value in report.get("clauses", {}).items()}}))
    if report["summary"]["fail"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
