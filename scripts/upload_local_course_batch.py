#!/usr/bin/env python3
"""Upload on-disk course MP4s to Odysee for same-course lessons (high-confidence pairs).

Match modes (course-scoped only; never cross-course):
  exact  — lesson title == file stem
  fuzzy  — mirrors HybridResolver localTitleKey: strip leading [NNN], normalize
           underscores/spaces, reject short/ambiguous keys (<=12 chars), prefer
           same [NNN] index when multiple files share a key

Claim names use a stable prefix + lesson index + slug. Dry-run by default; pass
--apply to upload.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import odysee_batch_upload as obu  # noqa: E402
from course_content_mapping import claim_belongs_to_course  # noqa: E402

DEFAULT_DSN = "postgresql://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite"
PROXY_MANIFEST = ROOT / "data" / "odysee_manifest.json"

# course_id -> (claim_prefix, tags)
COURSE_UPLOAD = {
    "Campus X DSMP (Data Science Mentorship Program)": (
        "campusx-dsmp-2026",
        ["campusx", "dsmp", "data-science", "courseforge"],
    ),
    "Sanket Elite 1.0": (
        "sanket-elite",
        ["sanket", "elite", "courseforge"],
    ),
    "Azure Data Engineering 2026 (Bhaskar Jogi)": (
        "bhaskar-jogi-azure",
        ["bhaskar", "azure", "courseforge"],
    ),
}

_INDEX_PREFIX = re.compile(r"^\[\d+\]\s*")


def lesson_index(title: str) -> str | None:
    m = re.match(r"^\[(\d+)\]\s*", title.strip())
    return m.group(1) if m else None


def local_title_key(title: str) -> str:
    """Mirror backend/internal/media.localTitleKey (index strip + short reject)."""
    s = title.strip().lower()
    s = _INDEX_PREFIX.sub("", s)
    s = s.replace("_", " ")
    s = " ".join(s.split())
    if len(s) <= 12:
        return ""
    return s


def make_claim_name(prefix: str, title: str) -> str:
    idx = lesson_index(title) or "000"
    body = re.sub(r"^\[\d+\]\s*", "", title).strip()
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", body.lower()).strip("-")
    name = f"{prefix}-{idx}-{slug}"
    return name[:80].strip("-")


def load_env_token(index: int = 1) -> tuple[str, str]:
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    if index <= 1:
        token = os.environ.get("ODYSEE_AUTH_TOKEN", "")
        channel = os.environ.get("ODYSEE_CHANNEL_ID", "")
    else:
        token = os.environ.get(f"ODYSEE_AUTH_TOKEN_{index}", "")
        channel = os.environ.get(f"ODYSEE_CHANNEL_ID_{index}", "")
    if not token or not channel:
        raise SystemExit(f"missing ODYSEE_AUTH_TOKEN / CHANNEL for wallet index {index}")
    return token, channel


def _unmapped_lessons(cur, course_id: str, only_without_provider: bool) -> list[tuple[str, str]]:
    if only_without_provider:
        cur.execute(
            """
            SELECT l.id, l.title FROM lessons l
            LEFT JOIN lesson_providers lp ON lp.lesson_id = l.id
            WHERE l.course_id = %s AND lp.lesson_id IS NULL
            ORDER BY l.sort_order, l.id
            """,
            (course_id,),
        )
    else:
        cur.execute(
            """
            SELECT l.id, l.title FROM lessons l
            WHERE l.course_id = %s
            ORDER BY l.sort_order, l.id
            """,
            (course_id,),
        )
    return cur.fetchall()


def _pair_row(
    cur,
    course_id: str,
    prefix: str,
    lid: str,
    title: str,
    path: Path,
    match_kind: str,
) -> dict | None:
    if not path.is_file() or path.stat().st_size <= 0:
        return None
    claim_name = make_claim_name(prefix, title)
    if not claim_belongs_to_course(claim_name, course_id, prefix):
        return None
    cur.execute(
        "SELECT claim_name, claim_id FROM lesson_providers WHERE lesson_id=%s",
        (lid,),
    )
    row = cur.fetchone()
    existing = {"claim_name": row[0], "claim_id": row[1]} if row else None
    return {
        "course_id": course_id,
        "lesson_id": lid,
        "lesson_title": title,
        "path": path,
        "claim_name": claim_name if not existing else existing["claim_name"],
        "existing_claim_id": (existing or {}).get("claim_id"),
        "bytes": path.stat().st_size,
        "match_kind": match_kind,
    }


def exact_pairs(conn, course_id: str, only_without_provider: bool) -> list[dict]:
    cur = conn.cursor()
    lessons = _unmapped_lessons(cur, course_id, only_without_provider)
    course_dir = ROOT / "courses" / course_id
    if not course_dir.is_dir():
        return []
    prefix, _tags = COURSE_UPLOAD[course_id]
    out: list[dict] = []
    for lid, title in lessons:
        path = course_dir / f"{title}.mp4"
        row = _pair_row(cur, course_id, prefix, lid, title, path, "exact")
        if row:
            out.append(row)
    return out


def fuzzy_pairs(conn, course_id: str, only_without_provider: bool) -> list[dict]:
    """High-confidence HybridResolver-style pairs (course-scoped key match).

    Exact title hits are included. Otherwise require a non-empty localTitleKey
    match; prefer a file whose [NNN] index matches the lesson. Does not use
    substring/contains matching (too ambiguous for minting claims).
    """
    cur = conn.cursor()
    lessons = _unmapped_lessons(cur, course_id, only_without_provider)
    course_dir = ROOT / "courses" / course_id
    if not course_dir.is_dir():
        return []
    prefix, _tags = COURSE_UPLOAD[course_id]

    by_key: dict[str, list[Path]] = {}
    for path in sorted(course_dir.glob("*.mp4")):
        if not path.is_file() or path.stat().st_size <= 0:
            continue
        key = local_title_key(path.stem)
        if not key:
            continue
        by_key.setdefault(key, []).append(path)

    out: list[dict] = []
    for lid, title in lessons:
        exact = course_dir / f"{title}.mp4"
        if exact.is_file() and exact.stat().st_size > 0:
            row = _pair_row(cur, course_id, prefix, lid, title, exact, "exact")
            if row:
                out.append(row)
            continue
        key = local_title_key(title)
        if not key:
            continue
        cands = by_key.get(key) or []
        if not cands:
            continue
        idx = lesson_index(title)
        chosen: Path | None = None
        kind = "key"
        if idx:
            for path in cands:
                if lesson_index(path.stem) == idx:
                    chosen = path
                    kind = "index"
                    break
        if chosen is None:
            # Prefer smaller file when several renumbered copies exist.
            chosen = min(cands, key=lambda p: p.stat().st_size)
        row = _pair_row(cur, course_id, prefix, lid, title, chosen, kind)
        if row:
            out.append(row)
    return out


def upload_one(token: str, channel_id: str, item: dict, tags: list[str]) -> str:
    path: Path = item["path"]
    claim_name = item["claim_name"]
    title = item["lesson_title"]
    print(
        f"UPLOAD {path.name} ({item['bytes'] / (1024 * 1024):.1f} MB) -> {claim_name}",
        flush=True,
    )
    existing = obu.check_claim_exists(claim_name)
    if existing and existing.get("claim_id") and not item.get("force_reupload"):
        print(f"  exists on-chain {existing['claim_id']}; skipping upload", flush=True)
        return existing["claim_id"]

    thumb = obu.extract_thumbnail(path)
    thumb_url = obu.upload_thumbnail(thumb) if thumb else "https://odysee.com/public/favicon.png"
    if thumb and thumb.exists():
        thumb.unlink(missing_ok=True)

    up_token, up_location = obu.request_upload_token(token)
    tus_url = obu.start_tus_upload(up_location, up_token, path)
    res = obu.create_claim_and_wait(
        auth_token=token,
        tus_file_url=tus_url,
        title=title,
        claim_name=claim_name,
        thumb_url=thumb_url,
        course_desc=item["course_id"][:240],
        base_tags=tags,
        channel_id=channel_id,
        unlisted=True,
    )
    outputs = res.get("outputs") or [{}]
    claim_id = outputs[0].get("claim_id") or ""
    if not claim_id:
        again = obu.check_claim_exists(claim_name)
        if again:
            claim_id = again["claim_id"]
    if not claim_id:
        raise RuntimeError(f"no claim_id returned for {claim_name}: {res}")
    print(f"  minted {claim_id}", flush=True)

    # Append to local manifest (best-effort)
    try:
        man = json.loads(PROXY_MANIFEST.read_text()) if PROXY_MANIFEST.exists() else {}
        key = f"{item['course_id']}/{path.name}"
        man[key] = {
            "course": item["course_id"],
            "title": title,
            "claim_name": claim_name,
            "claim_id": claim_id,
            "odysee_url": f"https://odysee.com/{claim_name}:{claim_id}",
            "stream_url": f"https://odysee.com/$/stream/{claim_name}/{claim_id}",
            "uploaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        PROXY_MANIFEST.write_text(json.dumps(man, indent=2))
    except Exception as exc:
        print(f"  manifest warn: {exc}", flush=True)
    return claim_id


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--course", required=True, choices=sorted(COURSE_UPLOAD))
    ap.add_argument("--dsn", default=DEFAULT_DSN)
    ap.add_argument("--wallet", type=int, default=1)
    ap.add_argument("--limit", type=int, default=1)
    ap.add_argument("--min-mb", type=float, default=0.0)
    ap.add_argument("--max-mb", type=float, default=0.0, help="0 = no max")
    ap.add_argument(
        "--match",
        choices=("exact", "fuzzy"),
        default="exact",
        help="exact title==stem, or HybridResolver localTitleKey fuzzy",
    )
    ap.add_argument("--include-with-provider", action="store_true")
    ap.add_argument("--apply", action="store_true", help="Actually upload")
    ap.add_argument("--csv-out", type=Path, default=Path("/tmp/upload_claims.csv"))
    args = ap.parse_args()

    conn = psycopg2.connect(args.dsn)
    pair_fn = fuzzy_pairs if args.match == "fuzzy" else exact_pairs
    pairs = pair_fn(conn, args.course, only_without_provider=not args.include_with_provider)
    # Prefer smaller files first for verified batches
    pairs.sort(key=lambda p: p["bytes"])
    filtered = []
    for p in pairs:
        mb = p["bytes"] / (1024 * 1024)
        if mb < args.min_mb:
            continue
        if args.max_mb > 0 and mb > args.max_mb:
            continue
        filtered.append(p)
    selected = filtered[: args.limit] if args.limit > 0 else filtered
    print(f"course={args.course} match={args.match}")
    print(f"candidates={len(pairs)} filtered={len(filtered)} selected={len(selected)}")
    for p in selected:
        print(
            f"  {p['bytes'] / (1024 * 1024):7.1f} MB | {p.get('match_kind', args.match)} | "
            f"{p['lesson_id']} | {p['claim_name']} | {p['path'].name[:55]}"
        )

    if not args.apply:
        print("dry-run only; pass --apply to upload")
        return 0

    token, channel = load_env_token(args.wallet)
    _prefix, tags = COURSE_UPLOAD[args.course]
    rows = []
    ok = fail = 0
    for item in selected:
        try:
            claim_id = upload_one(token, channel, item, tags)
            rows.append(
                {
                    "course_id": item["course_id"],
                    "lesson_id": item["lesson_id"],
                    "claim_name": item["claim_name"],
                    "claim_id": claim_id,
                }
            )
            ok += 1
        except Exception as exc:
            print(f"FAIL {item['path'].name}: {exc}", file=sys.stderr, flush=True)
            fail += 1
    with args.csv_out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["course_id", "lesson_id", "claim_name", "claim_id"])
        w.writeheader()
        w.writerows(rows)
    print(f"uploaded_ok={ok} fail={fail} csv={args.csv_out}")
    conn.close()
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
