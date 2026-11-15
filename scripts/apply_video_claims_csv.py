#!/usr/bin/env python3
"""Apply real video claim mappings from a CSV without inventing IDs.

CSV columns (header required):
  course_id,lesson_id,claim_name,claim_id
OR
  course_id,lesson_title,claim_name,claim_id

Rules:
- claim_id must be 40-char hex
- claim_name must not contain '-doc-'
- claim_name must match course claim_prefix when known (new_5_curricula.json)
- lesson must belong to course_id
- refuses cross-course / duplicate claim reuse across courses
- dry-run by default; pass --apply to write Postgres + SQLite
"""
from __future__ import annotations

import argparse
import csv
import re
import sqlite3
import sys
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from course_content_mapping import claim_belongs_to_course, is_document_claim  # noqa: E402

CLAIM_ID_RE = re.compile(r"^[0-9a-fA-F]{40}$")
DEFAULT_DSN = "postgresql://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite"
SQLITE = ROOT / "data" / "courseforge.sqlite3"
CURRICULA = ROOT / "new_5_curricula.json"


def load_prefixes():
    import json
    if not CURRICULA.exists():
        return {}
    data = json.loads(CURRICULA.read_text())
    return {c["course_key"]: c.get("claim_prefix") for c in data if isinstance(c, dict)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("csv_path", type=Path)
    ap.add_argument("--dsn", default=DEFAULT_DSN)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    prefixes = load_prefixes()
    rows = list(csv.DictReader(args.csv_path.open()))
    required_any = (("lesson_id",), ("lesson_title",))
    if not rows:
        print("empty csv")
        return 1
    if "course_id" not in rows[0] or "claim_name" not in rows[0] or "claim_id" not in rows[0]:
        print("CSV needs course_id,claim_name,claim_id and lesson_id or lesson_title")
        return 1

    conn = psycopg2.connect(args.dsn)
    cur = conn.cursor()
    cur.execute(
        """
        SELECT claim_id, array_agg(DISTINCT l.course_id)
        FROM lesson_providers lp JOIN lessons l ON l.id=lp.lesson_id
        WHERE length(claim_id)>5 GROUP BY claim_id
        """
    )
    claim_owners = {r[0]: set(r[1]) for r in cur.fetchall()}

    ok = rejected = 0
    planned = []
    for i, row in enumerate(rows, start=2):
        course = (row.get("course_id") or "").strip()
        cn = (row.get("claim_name") or "").strip()
        cid = (row.get("claim_id") or "").strip()
        lid = (row.get("lesson_id") or "").strip()
        title = (row.get("lesson_title") or "").strip()
        if not course or not cn or not cid:
            print(f"L{i}: missing required fields"); rejected += 1; continue
        if not CLAIM_ID_RE.match(cid):
            print(f"L{i}: invalid claim_id"); rejected += 1; continue
        if is_document_claim(cn):
            print(f"L{i}: refusing document claim on video path"); rejected += 1; continue
        prefix = prefixes.get(course)
        if prefix and not claim_belongs_to_course(cn, course, prefix):
            print(f"L{i}: claim not owned by course prefix"); rejected += 1; continue
        owners = claim_owners.get(cid, set())
        if owners and owners - {course}:
            print(f"L{i}: claim_id already used by other course {owners}"); rejected += 1; continue
        if lid:
            cur.execute("SELECT id FROM lessons WHERE id=%s AND course_id=%s", (lid, course))
        else:
            cur.execute("SELECT id FROM lessons WHERE course_id=%s AND title=%s", (course, title))
        found = cur.fetchall()
        if len(found) != 1:
            print(f"L{i}: lesson not uniquely found in course"); rejected += 1; continue
        lesson_id = found[0][0]
        planned.append((lesson_id, cn, cid, course))
        ok += 1

    print(f"accepted={ok} rejected={rejected}")
    if not args.apply:
        print("dry-run only; pass --apply to write")
        conn.close()
        return 0 if rejected == 0 else 2

    for lesson_id, cn, cid, course in planned:
        cur.execute(
            """
            INSERT INTO lesson_providers(lesson_id, claim_name, claim_id, updated_at)
            VALUES (%s,%s,%s,NOW())
            ON CONFLICT (lesson_id) DO UPDATE SET
              claim_name=EXCLUDED.claim_name,
              claim_id=EXCLUDED.claim_id,
              updated_at=NOW()
            """,
            (lesson_id, cn, cid),
        )
        claim_owners.setdefault(cid, set()).add(course)
    conn.commit()
    if SQLITE.exists():
        sq = sqlite3.connect(SQLITE)
        sc = sq.cursor()
        for lesson_id, cn, cid, _course in planned:
            sc.execute(
                """
                INSERT OR REPLACE INTO lecture_providers(video_id, claim_name, claim_id, updated_at)
                VALUES (?,?,?,datetime('now'))
                """,
                (lesson_id, cn, cid),
            )
        sq.commit()
        sq.close()
    print(f"applied={len(planned)}")
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
