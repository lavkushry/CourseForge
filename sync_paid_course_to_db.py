#!/usr/bin/env python3
"""
Register 'TrendyTech Ultimate Big Data Masters Program' (404 lectures, 36 modules,
syllabus, learning path, cover image, publication, and user enrollments) in CourseForge DB
both locally and on the live Linux server.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from build_paid_curriculum import (
    COURSE_CATEGORY,
    COURSE_DESCRIPTION,
    COURSE_INSTRUCTOR,
    COURSE_KEY,
    COURSE_TAGS,
    COURSE_TITLE,
    MODULES,
)


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def build_syllabus_and_path(videos: list[dict]) -> tuple[dict, dict, str]:
    now = utcnow()
    by_mod: dict[int, list[dict]] = {}
    for v in videos:
        by_mod.setdefault(v["module_num"], []).append(v)

    topics = []
    steps = []
    edges = []
    prev_step_id = None

    for mod_num, start_i, end_i, week_tag, mod_title, objs in MODULES:
        mod_vids = by_mod.get(mod_num, [])
        if not mod_vids:
            continue
        topic_title = f"Module {mod_num:02d}: {week_tag} — {mod_title}"
        sources = [
            {
                "video_id": v["video_id"],
                "start": 0.0,
                "video_title": v["title"],
                "course": COURSE_KEY,
            }
            for v in mod_vids
        ]
        topic_obj = {
            "order": mod_num,
            "title": topic_title[:120],
            "objectives": objs,
            "sources": [{k: s[k] for k in ("video_id", "start", "video_title")} for s in sources],
            "primary_source": {k: sources[0][k] for k in ("video_id", "start", "video_title")},
            "repeat_count": max(0, len(sources) - 1),
        }
        topics.append(topic_obj)

        step_id = f"t_{hashlib.sha256(topic_title.lower().encode()).hexdigest()[:12]}"
        step_obj = {
            "id": step_id,
            "order": mod_num,
            "title": topic_title[:120],
            "objectives": objs,
            "sources": sources,
            "courses": [COURSE_KEY],
            "primary_source": sources[0],
            "repeat_count": max(0, len(sources) - 1),
            "focus": True,
            "prerequisites": [prev_step_id] if prev_step_id else [],
        }
        steps.append(step_obj)
        if prev_step_id:
            edges.append({
                "before": prev_step_id,
                "after": step_id,
                "reason": f"Builds sequentially on {week_tag} concepts",
            })
        prev_step_id = step_id

    fingerprint = hashlib.sha256(
        json.dumps([(v["video_id"], now) for v in videos]).encode()
    ).hexdigest()[:16]

    syllabus_payload = {
        "course": COURSE_KEY,
        "topics": topics,
        "video_count": len(videos),
        "raw_topics": len( videos),
        "duplicates_collapsed": len(videos) - len(topics),
        "source_fingerprint": fingerprint,
        "generated_at": now,
    }

    path_payload = {
        "id": "lp_trendytech_bigdata_2026",
        "goal": "Master Cloud Data Engineering with Apache Spark, Databricks, Azure, AWS & Kafka",
        "courses": [COURSE_KEY],
        "steps": steps,
        "edges": edges,
        "source_fingerprint": fingerprint,
        "updated_at": now,
    }
    return syllabus_payload, path_payload, fingerprint


def apply_to_sqlite(db_path: Path, curriculum_path: Path):
    items = json.loads(curriculum_path.read_text())
    videos = [x for x in items if x["kind"] == "video"]
    now = utcnow()
    syllabus_payload, path_payload, fp = build_syllabus_and_path(videos)

    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.row_factory = sqlite3.Row
    with conn:
        for v in videos:
            vpath = f"/Users/lavkushkumar/Desktop/Courses/{COURSE_KEY}/{v['clean_filename']}"
            conn.execute(
                """INSERT INTO videos(id, path, course, title, bytes, mtime_ns, status, duration, language, indexed_at, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, 'done', ?, 'en', ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     path=excluded.path,
                     course=excluded.course,
                     title=excluded.title,
                     bytes=excluded.bytes,
                     duration=excluded.duration,
                     status='done',
                     indexed_at=COALESCE(videos.indexed_at, excluded.indexed_at)""",
                (
                    v["video_id"],
                    vpath,
                    COURSE_KEY,
                    v["title"],
                    v["size"],
                    1791650000000000000 + v["idx"],
                    float(v["duration"] or 0),
                    now,
                    now,
                ),
            )

        conn.execute(
            """INSERT INTO course_metadata(course, title, instructor, category, tags_json, cover_kind, updated_at)
               VALUES (?, ?, ?, ?, ?, 'custom', ?)
               ON CONFLICT(course) DO UPDATE SET
                 title=excluded.title,
                 instructor=excluded.instructor,
                 category=excluded.category,
                 tags_json=excluded.tags_json,
                 updated_at=excluded.updated_at""",
            (
                COURSE_KEY,
                COURSE_TITLE,
                COURSE_INSTRUCTOR,
                COURSE_CATEGORY,
                json.dumps(COURSE_TAGS),
                now,
            ),
        )

        # Ensure course_publication table exists
        conn.execute(
            """CREATE TABLE IF NOT EXISTS course_publication (
                 course TEXT PRIMARY KEY,
                 published INTEGER NOT NULL DEFAULT 0,
                 description TEXT NOT NULL DEFAULT '',
                 updated_at TEXT NOT NULL
               )"""
        )
        conn.execute(
            """INSERT INTO course_publication(course, published, description, updated_at)
               VALUES (?, 1, ?, ?)
               ON CONFLICT(course) DO UPDATE SET
                 published=1,
                 description=excluded.description,
                 updated_at=excluded.updated_at""",
            (COURSE_KEY, COURSE_DESCRIPTION, now),
        )

        conn.execute(
            """INSERT INTO syllabi(course, content_json, generated_at, source_fingerprint)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(course) DO UPDATE SET
                 content_json=excluded.content_json,
                 generated_at=excluded.generated_at,
                 source_fingerprint=excluded.source_fingerprint""",
            (COURSE_KEY, json.dumps(syllabus_payload), now, fp),
        )

        conn.execute(
            """INSERT INTO learning_paths(id, goal, courses_json, content_json, source_fingerprint, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 goal=excluded.goal,
                 courses_json=excluded.courses_json,
                 content_json=excluded.content_json,
                 source_fingerprint=excluded.source_fingerprint,
                 updated_at=excluded.updated_at""",
            (
                path_payload["id"],
                path_payload["goal"],
                json.dumps([COURSE_KEY]),
                json.dumps(path_payload),
                fp,
                now,
            ),
        )

        # Enroll all existing users if users/enrollments tables exist
        has_users = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
        ).fetchone()
        if has_users:
            uids = [r[0] for r in conn.execute("SELECT id FROM users").fetchall()]
            for uid in uids:
                conn.execute(
                    "INSERT OR IGNORE INTO enrollments(user_id, course, created_at) VALUES (?, ?, ?)",
                    (uid, COURSE_KEY, now),
                )
    conn.close()
    print(f"Updated SQLite DB at {db_path}: {len(videos)} lectures, 36 modules, syllabus & learning path registered.")


if __name__ == "__main__":
    curr = Path("/Users/lavkushkumar/Desktop/Courses/paid_curriculum.json")
    local_db = Path("/Users/lavkushkumar/Downloads/CourseForge/data/courseforge.sqlite3")
    if local_db.exists():
        apply_to_sqlite(local_db, curr)
