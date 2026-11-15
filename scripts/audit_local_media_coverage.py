#!/usr/bin/env python3
"""Report which PG lessons can resolve via on-disk course media (no Odysee).

Mirrors HybridResolver.findLocal title matching against CF_COURSES_DIR/courses/<id>.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import psycopg2

DEFAULT_DSN = "postgresql://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite"
DEFAULT_ROOT = os.environ.get("CF_COURSES_DIR") or os.environ.get("CF_ARTIFACT_ROOT") or "/home/ubuntu/CourseForge"


def _local_title_key(title: str) -> str:
    """Mirror backend/internal/media localTitleKey (index strip + short reject)."""
    trimmed = title.strip()
    if trimmed.startswith("[") and "]" in trimmed:
        inner = trimmed[1 : trimmed.index("]")]
        if inner.isdigit():
            trimmed = trimmed[trimmed.index("]") + 1 :].strip()
    key = " ".join(trimmed.lower().replace("_", " ").split())
    if len(key) < 16:
        return ""
    return key


def _iter_course_videos(check: Path):
    if not check.is_dir():
        return
    for entry in check.iterdir():
        if entry.is_file() and entry.suffix.lower() in (".mp4", ".mkv", ".webm"):
            yield entry
            continue
        if not entry.is_dir():
            continue
        for sub in entry.iterdir():
            if sub.is_file() and sub.suffix.lower() in (".mp4", ".mkv", ".webm"):
                yield sub


def find_local(root: Path, course_id: str, title: str) -> Path | None:
    want_key = _local_title_key(title)
    for check in (root / course_id, root / "courses" / course_id):
        if not check.is_dir():
            continue
        for ext in (".mp4", ".mkv", ".webm"):
            cand = check / f"{title}{ext}"
            if cand.is_file() and cand.stat().st_size > 0:
                return cand
        key_hits: list[Path] = []
        title_l = title.lower()
        contain_hit: Path | None = None
        for entry in _iter_course_videos(check):
            if entry.stat().st_size <= 0:
                continue
            lower = entry.name.lower()
            stem = Path(lower).stem
            if want_key and _local_title_key(stem) == want_key:
                key_hits.append(entry)
            elif contain_hit is None and (title_l in lower or stem in title_l):
                contain_hit = entry
        if key_hits:
            prefix = title.strip()[: title.strip().index("]") + 1] if title.strip().startswith("[") and "]" in title else ""
            if prefix:
                for hit in key_hits:
                    if hit.name.startswith(prefix):
                        return hit
            return key_hits[0]
        if contain_hit is not None:
            return contain_hit
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dsn", default=DEFAULT_DSN)
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--course", default="", help="Optional single course_id filter")
    args = ap.parse_args()
    root = Path(args.root)

    conn = psycopg2.connect(args.dsn)
    cur = conn.cursor()
    if args.course:
        cur.execute(
            "SELECT id, title FROM courses WHERE id=%s AND id NOT LIKE 'fixture%%'",
            (args.course,),
        )
    else:
        cur.execute("SELECT id, title FROM courses WHERE id NOT LIKE 'fixture%' ORDER BY id")
    courses = cur.fetchall()
    print(f"root={root}")
    total_local = 0
    for course_id, _title in courses:
        cur.execute(
            "SELECT id, title FROM lessons WHERE course_id=%s ORDER BY sort_order, id",
            (course_id,),
        )
        lessons = cur.fetchall()
        cur.execute(
            """
            SELECT count(lp.lesson_id) FROM lesson_providers lp
            JOIN lessons l ON l.id=lp.lesson_id WHERE l.course_id=%s
            """,
            (course_id,),
        )
        providers = cur.fetchone()[0]
        local = 0
        for _lid, ltitle in lessons:
            if find_local(root, course_id, ltitle):
                local += 1
        total_local += local
        if local or providers == 0:
            print(
                f"L={len(lessons):4d} local={local:4d} odysee_providers={providers:4d} | {course_id}"
            )
    print(f"TOTAL_LOCAL_RESOLVABLE_LESSONS={total_local}")
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
