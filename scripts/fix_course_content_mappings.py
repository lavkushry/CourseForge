#!/usr/bin/env python3
"""From-scratch repair of course → video and course → materials mappings.

Repairs:
1. new_5_curricula.json — study items no longer steal video ids/claims; foreign claims cleared
2. PostgreSQL — lessons/providers only for videos; materials for study/docs; purge doc-as-video
3. SQLite — videos/lecture_providers aligned to video lessons; course_materials_meta for materials

Dry-run by default. Pass --apply to write.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from course_content_mapping import (  # noqa: E402
    claim_belongs_to_course,
    detect_cross_course_contamination,
    index_docs_manifest,
    is_document_claim,
    material_id,
    material_type_for,
    partition_items,
    repair_course_items,
    resolve_material_relative_path,
)

CURRICULA_PATH = ROOT / "new_5_curricula.json"
DOCS_MANIFEST_PATH = ROOT / "data" / "odysee_docs_manifest.json"
SQLITE_PATH = ROOT / "data" / "courseforge.sqlite3"
DEFAULT_DSN = "postgresql://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite"


def load_json(path: Path):
    with path.open() as f:
        return json.load(f)


def save_json(path: Path, data) -> None:
    with path.open("w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def repair_curricula(curricula: list[dict], docs_index: dict) -> tuple[list[dict], dict]:
    stats = {
        "courses": 0,
        "videos": 0,
        "materials": 0,
        "cleared_study_claims": 0,
        "study_with_doc_claims": 0,
    }
    repaired_courses = []
    for course in curricula:
        stats["courses"] += 1
        before_items = course.get("items") or []
        before_study = [i for i in before_items if (i.get("kind") or "") == "study"]
        before_claims = {(i.get("claim_name"), i.get("claim_id")) for i in before_study}
        items = repair_course_items(course, docs_index)
        videos, materials = partition_items(items)
        stats["videos"] += len(videos)
        stats["materials"] += len(materials)
        after_study = [i for i in materials]
        after_claims = {(i.get("claim_name"), i.get("claim_id")) for i in after_study}
        # Count cleared / resolved roughly
        for item in after_study:
            if item.get("claim_name"):
                stats["study_with_doc_claims"] += 1
            else:
                stats["cleared_study_claims"] += 1
        # Prefer explicit cleared detection vs before
        if before_claims - after_claims:
            pass
        new_course = dict(course)
        new_course["items"] = items
        repaired_courses.append(new_course)
    return repaired_courses, stats


def apply_postgres(curricula: list[dict], docs_manifest: dict, dsn: str) -> dict:
    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    cur = conn.cursor()
    stats = {
        "courses_upserted": 0,
        "lessons_upserted": 0,
        "providers_upserted": 0,
        "materials_upserted": 0,
        "doc_providers_removed": 0,
        "orphan_study_lessons_removed": 0,
        "foreign_providers_removed": 0,
    }

    video_lesson_ids: set[str] = set()
    study_only_ids: set[str] = set()

    try:
        for course in curricula:
            course_key = course["course_key"]
            title = course.get("course_title") or course_key
            desc = course.get("description") or ""
            instructor = course.get("instructor") or ""
            category = course.get("category") or ""
            tags = course.get("tags") or []
            cur.execute(
                """
                INSERT INTO courses (id, title, description, published, instructor, category, tags, updated_at)
                VALUES (%s, %s, %s, true, %s, %s, %s::text[], NOW())
                ON CONFLICT (id) DO UPDATE SET
                  title = EXCLUDED.title,
                  description = EXCLUDED.description,
                  published = true,
                  instructor = EXCLUDED.instructor,
                  category = EXCLUDED.category,
                  tags = EXCLUDED.tags,
                  updated_at = NOW()
                """,
                (course_key, title, desc, instructor, category, tags),
            )
            stats["courses_upserted"] += 1

            videos, materials = partition_items(course.get("items") or [])
            claim_prefix = course.get("claim_prefix")

            videos_sorted = sorted(videos, key=lambda x: (int(x.get("idx") or 0), int(x.get("msg_id") or 0)))
            for seq, item in enumerate(videos_sorted, start=1):
                lid = item.get("video_id")
                if not lid:
                    continue
                video_lesson_ids.add(lid)
                idx = int(item.get("idx") or seq)
                l_title = item.get("title") or f"Lesson {seq}"
                sec = item.get("module_title") or f"Module {item.get('module_num') or 1}"
                dur = float(item.get("duration") or 0) or 0.0
                cur.execute(
                    """
                    INSERT INTO lessons (
                      id, course_id, title, sort_order, duration_seconds,
                      section_title, flow_order, status, created_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, 'done', NOW())
                    ON CONFLICT (id) DO UPDATE SET
                      course_id = EXCLUDED.course_id,
                      title = EXCLUDED.title,
                      sort_order = EXCLUDED.sort_order,
                      duration_seconds = EXCLUDED.duration_seconds,
                      section_title = EXCLUDED.section_title,
                      flow_order = EXCLUDED.flow_order,
                      status = 'done'
                    """,
                    (lid, course_key, l_title, seq, dur, sec, float(seq)),
                )
                stats["lessons_upserted"] += 1

                cname = item.get("claim_name") or ""
                cid = item.get("claim_id") or ""
                if (
                    cname
                    and cid
                    and not is_document_claim(cname)
                    and claim_belongs_to_course(cname, course_key, claim_prefix)
                ):
                    cur.execute(
                        """
                        INSERT INTO lesson_providers (lesson_id, claim_name, claim_id, updated_at)
                        VALUES (%s, %s, %s, NOW())
                        ON CONFLICT (lesson_id) DO UPDATE SET
                          claim_name = EXCLUDED.claim_name,
                          claim_id = EXCLUDED.claim_id,
                          updated_at = NOW()
                        """,
                        (lid, cname, cid),
                    )
                    stats["providers_upserted"] += 1
                else:
                    cur.execute("DELETE FROM lesson_providers WHERE lesson_id = %s", (lid,))

            for pos, item in enumerate(materials, start=1):
                filename = (
                    item.get("clean_filename")
                    or item.get("orig_filename")
                    or item.get("title")
                    or f"material-{pos}"
                )
                filename = str(filename).replace("\\", "/").split("/")[-1][:255]
                mid = item.get("material_id") or material_id(course_key, filename)
                # Track former study lesson ids for cleanup when present in DB history.
                legacy = item.get("legacy_video_id")
                if legacy:
                    study_only_ids.add(legacy)

                cname = item.get("claim_name") or ""
                cid = item.get("claim_id") or ""
                if cname and not claim_belongs_to_course(cname, course_key, claim_prefix):
                    cname, cid = "", ""
                if cname and not is_document_claim(cname):
                    # Refuse to store video claims on materials.
                    cname, cid = "", ""

                m_title = item.get("title") or filename
                rel = resolve_material_relative_path(course_key, filename, root=str(ROOT))
                mtype = material_type_for(filename)
                section = item.get("module_title") or ""
                cur.execute(
                    """
                    INSERT INTO materials (
                      id, course_id, lesson_id, filename, title, material_type, scope,
                      section_title, position, relative_path, claim_name, claim_id,
                      removed, updated_at
                    ) VALUES (
                      %s, %s, NULL, %s, %s, %s, 'course', %s, %s, %s, %s, %s, false, NOW()
                    )
                    ON CONFLICT (course_id, filename) DO UPDATE SET
                      title = EXCLUDED.title,
                      material_type = EXCLUDED.material_type,
                      section_title = EXCLUDED.section_title,
                      position = EXCLUDED.position,
                      relative_path = EXCLUDED.relative_path,
                      claim_name = EXCLUDED.claim_name,
                      claim_id = EXCLUDED.claim_id,
                      removed = false,
                      updated_at = NOW()
                    """,
                    (mid, course_key, filename, m_title, mtype, section, float(pos), rel, cname, cid),
                )
                stats["materials_upserted"] += 1

        # Docs manifest entries (authoritative companion inventory)
        for key, entry in docs_manifest.items():
            if not isinstance(entry, dict):
                continue
            course_key = entry.get("course") or ""
            name = entry.get("name") or ""
            cname = entry.get("claim_name") or ""
            cid = entry.get("claim_id") or ""
            if not course_key or not name or not cname or not cid:
                continue
            # Skip if course not present
            cur.execute("SELECT 1 FROM courses WHERE id = %s", (course_key,))
            if cur.fetchone() is None:
                continue
            # Prefix check using curricula prefix when available
            prefix = next((c.get("claim_prefix") for c in curricula if c["course_key"] == course_key), None)
            if prefix and not claim_belongs_to_course(cname, course_key, prefix):
                continue
            filename = str(name).replace("\\", "/").split("/")[-1][:255]
            mid = material_id(course_key, filename)
            rel = resolve_material_relative_path(
                course_key,
                filename,
                root=str(ROOT),
                preferred=entry.get("relative_path"),
            )
            m_title = entry.get("title") or filename
            cur.execute(
                """
                INSERT INTO materials (
                  id, course_id, lesson_id, filename, title, material_type, scope,
                  section_title, position, relative_path, claim_name, claim_id,
                  removed, updated_at
                ) VALUES (
                  %s, %s, NULL, %s, %s, %s, 'course', '', 0, %s, %s, %s, false, NOW()
                )
                ON CONFLICT (course_id, filename) DO UPDATE SET
                  claim_name = EXCLUDED.claim_name,
                  claim_id = EXCLUDED.claim_id,
                  relative_path = EXCLUDED.relative_path,
                  scope = COALESCE(NULLIF(materials.scope, ''), 'course'),
                  removed = false,
                  updated_at = NOW()
                """,
                (mid, course_key, filename, m_title, material_type_for(filename), rel, cname, cid),
            )
            stats["materials_upserted"] += 1

        # Purge document claims from lesson_providers globally
        cur.execute(
            """
            DELETE FROM lesson_providers lp
            WHERE lp.claim_name LIKE '%-doc-%'
               OR lp.claim_name LIKE '%-doc'
            """
        )
        stats["doc_providers_removed"] = cur.rowcount

        # Purge providers whose claim does not belong to the lesson's course prefix
        prefix_by_course = {c["course_key"]: c.get("claim_prefix") for c in curricula}
        cur.execute(
            """
            SELECT lp.lesson_id, lp.claim_name, l.course_id
            FROM lesson_providers lp
            JOIN lessons l ON l.id = lp.lesson_id
            """
        )
        foreign = []
        for lesson_id, claim_name, course_id in cur.fetchall():
            prefix = prefix_by_course.get(course_id)
            if prefix is None:
                continue
            if not claim_belongs_to_course(claim_name, course_id, prefix):
                foreign.append(lesson_id)
        if foreign:
            cur.execute("DELETE FROM lesson_providers WHERE lesson_id = ANY(%s)", (foreign,))
            stats["foreign_providers_removed"] = cur.rowcount

        # Remove study-only leftovers for curricula courses. These rows were created when
        # sync scripts treated kind=study as video lessons; progress on them is synthetic
        # contamination from that bug, so delete the lesson rows entirely (FK cascades).
        if video_lesson_ids:
            curricula_keys = [c["course_key"] for c in curricula]
            cur.execute(
                """
                SELECT l.id
                FROM lessons l
                WHERE l.course_id = ANY(%s)
                  AND NOT (l.id = ANY(%s))
                """,
                (curricula_keys, list(video_lesson_ids)),
            )
            orphan_ids = [r[0] for r in cur.fetchall()]
            if orphan_ids:
                cur.execute(
                    "DELETE FROM lesson_providers WHERE lesson_id = ANY(%s)",
                    (orphan_ids,),
                )
                cur.execute("DELETE FROM lessons WHERE id = ANY(%s)", (orphan_ids,))
                stats["orphan_study_lessons_removed"] = cur.rowcount

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()
    return stats


def apply_sqlite(curricula: list[dict]) -> dict:
    if not SQLITE_PATH.exists():
        return {"skipped": True}
    conn = sqlite3.connect(SQLITE_PATH)
    cur = conn.cursor()
    stats = {"videos": 0, "providers": 0, "materials_meta": 0, "doc_providers_removed": 0}
    try:
        cur.execute("DELETE FROM lecture_providers WHERE claim_name LIKE '%-doc-%'")
        stats["doc_providers_removed"] = cur.rowcount

        for course in curricula:
            course_key = course["course_key"]
            videos, materials = partition_items(course.get("items") or [])
            claim_prefix = course.get("claim_prefix")

            cur.execute(
                """
                INSERT OR REPLACE INTO course_metadata (course, title, instructor, category, tags_json, updated_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))
                """,
                (
                    course_key,
                    course.get("course_title") or course_key,
                    course.get("instructor") or "",
                    course.get("category") or "",
                    json.dumps(course.get("tags") or []),
                ),
            )
            cur.execute(
                """
                INSERT OR REPLACE INTO course_publication (course, published, description, updated_at)
                VALUES (?, 1, ?, datetime('now'))
                """,
                (course_key, course.get("description") or ""),
            )

            keep_video_ids = []
            for item in videos:
                lid = item.get("video_id")
                if not lid:
                    continue
                keep_video_ids.append(lid)
                cf = item.get("clean_filename") or item.get("title") or lid
                dur = float(item.get("duration") or 0) or 0.0
                cur.execute(
                    """
                    INSERT OR REPLACE INTO videos
                      (id, path, course, title, bytes, mtime_ns, status, duration, created_at)
                    VALUES (?, ?, ?, ?, ?, 0, 'ready', ?, datetime('now'))
                    """,
                    (
                        lid,
                        f"courses/{course_key}/{cf}",
                        course_key,
                        item.get("title") or cf,
                        int(item.get("size") or 0) or 100000000,
                        dur,
                    ),
                )
                stats["videos"] += 1
                cname = item.get("claim_name") or ""
                cid = item.get("claim_id") or ""
                if (
                    cname
                    and cid
                    and not is_document_claim(cname)
                    and claim_belongs_to_course(cname, course_key, claim_prefix)
                ):
                    cur.execute(
                        """
                        INSERT OR REPLACE INTO lecture_providers (video_id, claim_name, claim_id, updated_at)
                        VALUES (?, ?, ?, datetime('now'))
                        """,
                        (lid, cname, cid),
                    )
                    stats["providers"] += 1
                else:
                    cur.execute("DELETE FROM lecture_providers WHERE video_id = ?", (lid,))

            # Drop providers and non-video rows for this course in SQLite
            if keep_video_ids:
                placeholders = ",".join("?" for _ in keep_video_ids)
                cur.execute(
                    f"""
                    DELETE FROM lecture_providers
                    WHERE video_id IN (
                      SELECT id FROM videos WHERE course = ? AND id NOT IN ({placeholders})
                    )
                    """,
                    [course_key, *keep_video_ids],
                )
                cur.execute(
                    f"DELETE FROM videos WHERE course = ? AND id NOT IN ({placeholders})",
                    [course_key, *keep_video_ids],
                )

            for pos, item in enumerate(materials, start=1):
                filename = (
                    item.get("clean_filename")
                    or item.get("orig_filename")
                    or item.get("title")
                    or "material"
                )
                filename = str(filename).replace("\\", "/").split("/")[-1]
                mid = item.get("material_id") or material_id(course_key, filename)
                friendly = item.get("title") or filename
                mtype = material_type_for(filename)
                section = item.get("module_title") or ""
                try:
                    cur.execute(
                        """
                        INSERT OR REPLACE INTO course_materials_meta
                          (id, course, filename, friendly_name, material_type, lesson_id,
                           section_title, scope, position, removed, updated_at)
                        VALUES (?, ?, ?, ?, ?, NULL, ?, 'course', ?, 0, datetime('now'))
                        """,
                        (mid, course_key, filename, friendly, mtype, section, pos),
                    )
                    stats["materials_meta"] += 1
                except sqlite3.Error:
                    # Older schemas vary; best-effort.
                    pass

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()
    return stats


def verify(dsn: str, curricula: list[dict]) -> dict:
    conn = psycopg2.connect(dsn)
    cur = conn.cursor()
    report = {}
    cur.execute(
        """
        SELECT count(*) FROM lesson_providers
        WHERE claim_name LIKE '%-doc-%' OR claim_name LIKE '%-doc'
        """
    )
    report["doc_as_video_providers"] = cur.fetchone()[0]

    cur.execute(
        """
        SELECT claim_id, count(DISTINCT l.course_id)
        FROM lesson_providers lp
        JOIN lessons l ON l.id = lp.lesson_id
        WHERE length(claim_id) > 5
        GROUP BY claim_id
        HAVING count(DISTINCT l.course_id) > 1
        """
    )
    report["shared_video_claims"] = cur.rowcount if cur.description else 0
    shared = cur.fetchall()
    report["shared_video_claims"] = len(shared)

    # Study/video id collision in curricula after repair
    collisions = 0
    for course in curricula:
        videos, materials = partition_items(course.get("items") or [])
        v_ids = {i.get("video_id") for i in videos if i.get("video_id")}
        m_ids = {i.get("material_id") for i in materials if i.get("material_id")}
        # material ids use mat_ prefix; ensure no video_id left on materials
        for item in materials:
            if item.get("video_id"):
                collisions += 1
        _ = v_ids, m_ids
    report["study_items_still_holding_video_id"] = collisions
    report["cross_course_claim_findings"] = len(detect_cross_course_contamination(curricula))

    # Per-course mapped video counts
    rows = []
    for course in curricula:
        ck = course["course_key"]
        videos, materials = partition_items(course.get("items") or [])
        cur.execute(
            """
            SELECT count(l.id), count(lp.lesson_id),
                   (SELECT count(*) FROM materials m WHERE m.course_id=%s AND NOT m.removed)
            FROM lessons l
            LEFT JOIN lesson_providers lp ON lp.lesson_id = l.id
            WHERE l.course_id = %s
            """,
            (ck, ck),
        )
        lessons, providers, mats = cur.fetchone()
        rows.append(
            {
                "course": ck,
                "curricula_videos": len(videos),
                "curricula_materials": len(materials),
                "db_lessons": lessons,
                "db_providers": providers,
                "db_materials": mats,
            }
        )
    report["courses"] = rows
    cur.close()
    conn.close()
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Write curricula + databases")
    parser.add_argument("--dsn", default=DEFAULT_DSN)
    parser.add_argument("--skip-sqlite", action="store_true")
    parser.add_argument("--skip-postgres", action="store_true")
    args = parser.parse_args()

    curricula = load_json(CURRICULA_PATH)
    docs_manifest = load_json(DOCS_MANIFEST_PATH)
    docs_index = index_docs_manifest(docs_manifest)

    print("Repairing curricula item ownership…")
    repaired, cstats = repair_curricula(curricula, docs_index)
    findings_before = detect_cross_course_contamination(curricula)
    findings_after = detect_cross_course_contamination(repaired)
    print(f"  courses={cstats['courses']} videos={cstats['videos']} materials={cstats['materials']}")
    print(f"  study_with_doc_claims={cstats['study_with_doc_claims']} cleared_or_unmapped={cstats['cleared_study_claims']}")
    print(f"  cross-course claim findings: before={len(findings_before)} after={len(findings_after)}")

    if not args.apply:
        print("Dry-run only. Re-run with --apply to persist.")
        # Still print a quick verification against current DB
        try:
            report = verify(args.dsn, repaired)
            print(
                "Current DB (unchanged) vs repaired plan:",
                f"doc_as_video={report['doc_as_video_providers']}",
                f"shared_video_claims={report['shared_video_claims']}",
            )
        except Exception as exc:
            print(f"DB verify skipped: {exc}")
        return 0

    backup = CURRICULA_PATH.with_suffix(".json.bak_mapping_fix")
    if not backup.exists():
        backup.write_text(CURRICULA_PATH.read_text())
        print(f"  backup → {backup}")
    save_json(CURRICULA_PATH, repaired)
    print(f"  wrote {CURRICULA_PATH}")

    if not args.skip_postgres:
        print("Applying PostgreSQL mapping repair…")
        pg_stats = apply_postgres(repaired, docs_manifest, args.dsn)
        print(" ", pg_stats)

    if not args.skip_sqlite:
        print("Applying SQLite mapping repair…")
        sq_stats = apply_sqlite(repaired)
        print(" ", sq_stats)

    report = verify(args.dsn, repaired)
    print("Verification:")
    print(
        f"  doc_as_video_providers={report['doc_as_video_providers']} "
        f"shared_video_claims={report['shared_video_claims']} "
        f"study_video_id_collisions={report['study_items_still_holding_video_id']} "
        f"curricula_cross_claims={report['cross_course_claim_findings']}"
    )
    bad = [
        row
        for row in report["courses"]
        if row["db_providers"] > row["curricula_videos"]  # providers should not exceed videos
    ]
    if report["doc_as_video_providers"] or report["shared_video_claims"] or report["study_items_still_holding_video_id"]:
        print("FAILED verification gates")
        return 1
    print(f"  courses checked={len(report['courses'])} provider_overcount={len(bad)}")
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
