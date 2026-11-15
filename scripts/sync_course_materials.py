#!/usr/bin/env python3
"""From-scratch course → materials sync (PostgreSQL + SQLite).

Rebuilds the ``materials`` table so every published course maps to the correct
companion files/claims with resolvable relative_path and classroom-visible scope.

Sources (merged, course-scoped):
  1. On-disk files under courses/<course>/ (non-video)
  2. Generated companions under data/materials/<course>/
  3. data/odysee_docs_manifest.json (Odysee doc claims)
  4. new_5_curricula.json study/document items
  5. COMPANION_MATERIALS_AUDIT.json (lesson hints + claim fallback)

Does NOT modify lessons / lesson_providers / video claims.

Dry-run by default. Pass --apply to write.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import psycopg2

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from course_content_mapping import (  # noqa: E402
    claim_belongs_to_course,
    infer_material_placement,
    is_document_claim,
    is_material_filename,
    material_id,
    material_type_for,
    resolve_material_relative_path,
)

CURRICULA_PATH = ROOT / "new_5_curricula.json"
DOCS_MANIFEST_PATH = ROOT / "data" / "odysee_docs_manifest.json"
AUDIT_PATH = ROOT / "COMPANION_MATERIALS_AUDIT.json"
SQLITE_PATH = ROOT / "data" / "courseforge.sqlite3"
COURSES_DIR = ROOT / "courses"
DATA_MATERIALS_DIR = ROOT / "data" / "materials"
DEFAULT_DSN = os.environ.get(
    "CF_DATABASE_URL",
    "postgresql://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite",
)


@dataclass
class MaterialRow:
    course_id: str
    filename: str
    title: str
    material_type: str
    scope: str = "course"
    lesson_id: str | None = None
    section_title: str = ""
    position: float = 0.0
    relative_path: str = ""
    claim_name: str = ""
    claim_id: str = ""
    sources: set[str] = field(default_factory=set)

    @property
    def id(self) -> str:
        return material_id(self.course_id, self.filename)


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def iter_disk_materials(base: Path, course_key: str) -> list[tuple[str, str]]:
    """Return (filename, relative_path) for material files under base/course_key."""
    course_dir = base / course_key
    if not course_dir.is_dir():
        return []
    out: list[tuple[str, str]] = []
    for path in sorted(course_dir.rglob("*")):
        if not path.is_file():
            continue
        if not is_material_filename(path.name):
            continue
        try:
            rel = path.relative_to(ROOT).as_posix()
        except ValueError:
            continue
        out.append((path.name, rel))
    return out


def collect_inventory(
    curricula: list[dict],
    docs_manifest: dict,
    audit: list[dict],
    course_ids: set[str],
    prefix_by_course: dict[str, str | None],
    lessons_by_course: dict[str, list[dict]],
) -> dict[tuple[str, str], MaterialRow]:
    rows: dict[tuple[str, str], MaterialRow] = {}

    def upsert(
        course_id: str,
        filename: str,
        *,
        title: str | None = None,
        relative_path: str | None = None,
        claim_name: str = "",
        claim_id: str = "",
        lesson_id: str | None = None,
        module_title: str = "",
        position: float = 0.0,
        source: str,
    ) -> None:
        if course_id not in course_ids:
            return
        filename = str(filename).replace("\\", "/").split("/")[-1]
        if not is_material_filename(filename):
            return
        key = (course_id, filename)
        row = rows.get(key)
        if row is None:
            row = MaterialRow(
                course_id=course_id,
                filename=filename,
                title=title or filename,
                material_type=material_type_for(filename),
            )
            rows[key] = row
        row.sources.add(source)
        if title and (not row.title or row.title == row.filename):
            row.title = title
        if position and (not row.position or position < row.position or row.position == 0):
            row.position = float(position)

        # Claims: only accept course-owned document claims.
        if claim_name and claim_id and is_document_claim(claim_name):
            if claim_belongs_to_course(claim_name, course_id, prefix_by_course.get(course_id)):
                row.claim_name = claim_name
                row.claim_id = claim_id

        if relative_path:
            row.relative_path = resolve_material_relative_path(
                course_id, filename, root=str(ROOT), preferred=relative_path
            )
        elif not row.relative_path:
            row.relative_path = resolve_material_relative_path(
                course_id, filename, root=str(ROOT)
            )

        # Placement hints accumulate; finalized after all sources merge.
        if lesson_id and not row.lesson_id:
            row.lesson_id = lesson_id
        if module_title and not row.section_title:
            row.section_title = module_title

    # 1) Disk: courses/<course>/
    for course_id in sorted(course_ids):
        for filename, rel in iter_disk_materials(COURSES_DIR, course_id):
            upsert(course_id, filename, relative_path=rel, source="disk_courses")

    # 2) Disk: data/materials/<course>/
    for course_id in sorted(course_ids):
        for filename, rel in iter_disk_materials(DATA_MATERIALS_DIR, course_id):
            upsert(course_id, filename, relative_path=rel, source="disk_data_materials")

    # 3) Docs manifest
    for key, entry in docs_manifest.items():
        if not isinstance(entry, dict):
            continue
        course_id = entry.get("course") or ""
        name = entry.get("name") or entry.get("filename") or ""
        if not course_id or not name:
            # Fallback from key "course/filename"
            if "/" in str(key):
                course_id, name = str(key).split("/", 1)
            else:
                continue
        upsert(
            course_id,
            name,
            title=entry.get("title") or name,
            claim_name=entry.get("claim_name") or "",
            claim_id=entry.get("claim_id") or "",
            relative_path=entry.get("relative_path"),
            source="docs_manifest",
        )

    # 4) Curricula study items
    for course in curricula:
        course_id = course.get("course_key") or ""
        if not course_id:
            continue
        for pos, item in enumerate(course.get("items") or [], start=1):
            kind = str(item.get("kind") or "").strip().lower()
            fname = item.get("clean_filename") or item.get("orig_filename") or item.get("title")
            if kind not in {"study", "document", "material", "doc"} and not is_material_filename(
                str(fname or "")
            ):
                continue
            if not fname:
                continue
            upsert(
                course_id,
                str(fname),
                title=item.get("title") or str(fname),
                claim_name=item.get("claim_name") or "",
                claim_id=item.get("claim_id") or "",
                lesson_id=item.get("lesson_id") or item.get("legacy_video_id"),
                module_title=item.get("module_title") or "",
                position=float(item.get("flow_order") or pos),
                source="curricula",
            )

    # 5) Audit catalog
    for item in audit:
        if not isinstance(item, dict):
            continue
        course_id = item.get("course_id") or ""
        filename = item.get("filename") or ""
        if not course_id or not filename:
            continue
        upsert(
            course_id,
            filename,
            title=filename,
            claim_name=item.get("current_claim_name") or "",
            claim_id=item.get("current_claim_id") or "",
            lesson_id=item.get("current_lesson_id"),
            relative_path=item.get("relative_path") or item.get("server_path"),
            source="audit",
        )

    # Finalize placement + paths
    for row in rows.values():
        row.relative_path = resolve_material_relative_path(
            row.course_id,
            row.filename,
            root=str(ROOT),
            preferred=row.relative_path or None,
        )
        scope, lesson_id, section = infer_material_placement(
            filename=row.filename,
            title=row.title,
            module_title=row.section_title,
            preferred_lesson_id=row.lesson_id,
            lessons=lessons_by_course.get(row.course_id) or [],
        )
        # If preferred lesson was a single dump for hundreds of files, infer_material_placement
        # already falls through when lesson id invalid; when valid but shared by many, demote.
        row.scope = scope
        row.lesson_id = lesson_id
        row.section_title = section
        if not row.position:
            row.position = 0.0
        # Strip non-document / foreign claims
        if row.claim_name and (
            not is_document_claim(row.claim_name)
            or not claim_belongs_to_course(
                row.claim_name, row.course_id, prefix_by_course.get(row.course_id)
            )
        ):
            row.claim_name = ""
            row.claim_id = ""

    # Demote single-lesson dumps: if >5 materials share one lesson_id under lesson scope,
    # re-infer without that preferred id (forces section/course).
    by_course_lesson: dict[tuple[str, str], list[MaterialRow]] = defaultdict(list)
    for row in rows.values():
        if row.scope == "lesson" and row.lesson_id:
            by_course_lesson[(row.course_id, row.lesson_id)].append(row)
    for (_course, _lid), group in by_course_lesson.items():
        if len(group) < 5:
            continue
        for row in group:
            # Drop the dumped lesson's section hint — it pollutes rematch.
            scope, lesson_id, section = infer_material_placement(
                filename=row.filename,
                title=row.title,
                module_title="",
                preferred_lesson_id=None,
                lessons=lessons_by_course.get(row.course_id) or [],
            )
            row.scope = scope
            row.lesson_id = lesson_id
            row.section_title = section

    # If section/lesson placement leaves most lessons without materials, promote
    # the course's companions to course scope so the study rail is never empty.
    by_course: dict[str, list[MaterialRow]] = defaultdict(list)
    for row in rows.values():
        by_course[row.course_id].append(row)
    for course_id, group in by_course.items():
        lessons = lessons_by_course.get(course_id) or []
        if not lessons or not group:
            continue
        visible = 0
        for lesson in lessons:
            lid = str(lesson.get("id") or "")
            sec = str(lesson.get("section_title") or "")
            for row in group:
                if (
                    (row.scope == "lesson" and row.lesson_id == lid)
                    or (row.scope == "section" and row.section_title == sec)
                    or row.scope == "course"
                ):
                    visible += 1
                    break
        if visible < max(1, int(len(lessons) * 0.5)):
            for row in group:
                row.scope = "course"
                row.lesson_id = None
                # Keep section_title as metadata only; scope=course drives visibility.

    # Assign stable positions within course
    for course_id, group in by_course.items():
        group.sort(key=lambda r: (r.position or 10_000, r.filename.lower()))
        for idx, row in enumerate(group, start=1):
            if not row.position:
                row.position = float(idx)

    return rows


def apply_postgres(
    dsn: str,
    rows: dict[tuple[str, str], MaterialRow],
    course_ids: set[str],
) -> dict[str, int]:
    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    cur = conn.cursor()
    stats = {"upserted": 0, "marked_removed": 0, "kept_foreign": 0}
    try:
        # Soft-remove existing materials for known courses, then upsert active set.
        cur.execute(
            """
            UPDATE materials
               SET removed = true, updated_at = NOW()
             WHERE course_id = ANY(%s) AND NOT removed
            """,
            (list(course_ids),),
        )
        stats["marked_removed"] = cur.rowcount

        for row in rows.values():
            cur.execute(
                """
                INSERT INTO materials (
                  id, course_id, lesson_id, filename, title, material_type, scope,
                  section_title, position, relative_path, claim_name, claim_id,
                  removed, updated_at
                ) VALUES (
                  %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, %s, %s,
                  false, NOW()
                )
                ON CONFLICT (course_id, filename) DO UPDATE SET
                  id = EXCLUDED.id,
                  lesson_id = EXCLUDED.lesson_id,
                  title = EXCLUDED.title,
                  material_type = EXCLUDED.material_type,
                  scope = EXCLUDED.scope,
                  section_title = EXCLUDED.section_title,
                  position = EXCLUDED.position,
                  relative_path = EXCLUDED.relative_path,
                  claim_name = EXCLUDED.claim_name,
                  claim_id = EXCLUDED.claim_id,
                  removed = false,
                  updated_at = NOW()
                """,
                (
                    row.id,
                    row.course_id,
                    row.lesson_id,
                    row.filename,
                    row.title,
                    row.material_type,
                    row.scope,
                    row.section_title,
                    float(row.position),
                    row.relative_path,
                    row.claim_name or "",
                    row.claim_id or "",
                ),
            )
            stats["upserted"] += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()
    return stats


def apply_sqlite(rows: dict[tuple[str, str], MaterialRow], course_ids: set[str]) -> dict[str, int]:
    if not SQLITE_PATH.exists():
        return {"skipped": 1}
    conn = sqlite3.connect(SQLITE_PATH)
    cur = conn.cursor()
    stats = {"upserted": 0, "removed": 0}
    try:
        cur.execute(
            f"""
            UPDATE course_materials_meta
               SET removed = 1, updated_at = datetime('now')
             WHERE course IN ({",".join("?" for _ in course_ids)})
            """,
            list(course_ids),
        )
        stats["removed"] = cur.rowcount
        for row in rows.values():
            # Normalize id for (course, filename) — schema has UNIQUE(course, filename)
            # and PRIMARY KEY(id); replace any prior id for the same pair.
            cur.execute(
                "DELETE FROM course_materials_meta WHERE course = ? AND filename = ?",
                (row.course_id, row.filename),
            )
            cur.execute(
                """
                INSERT INTO course_materials_meta (
                  id, course, filename, friendly_name, material_type, lesson_id,
                  section_title, scope, position, removed, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
                ON CONFLICT(id) DO UPDATE SET
                  course = excluded.course,
                  filename = excluded.filename,
                  friendly_name = excluded.friendly_name,
                  material_type = excluded.material_type,
                  lesson_id = excluded.lesson_id,
                  section_title = excluded.section_title,
                  scope = excluded.scope,
                  position = excluded.position,
                  removed = 0,
                  updated_at = datetime('now')
                """,
                (
                    row.id,
                    row.course_id,
                    row.filename,
                    row.title,
                    row.material_type,
                    row.lesson_id,
                    row.section_title,
                    row.scope,
                    float(row.position),
                ),
            )
            stats["upserted"] += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()
    return stats


def verify(dsn: str, rows: dict[tuple[str, str], MaterialRow]) -> dict[str, Any]:
    conn = psycopg2.connect(dsn)
    cur = conn.cursor()
    report: dict[str, Any] = {}
    cur.execute("SELECT COUNT(*) FROM materials WHERE NOT removed")
    report["active_materials"] = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM materials WHERE NOT removed AND claim_id <> ''")
    report["with_claim"] = cur.fetchone()[0]
    cur.execute(
        """
        SELECT COUNT(*) FROM lessons l
        WHERE EXISTS (
          SELECT 1 FROM materials m
          WHERE m.course_id = l.course_id AND NOT m.removed AND (
            m.lesson_id = l.id
            OR (m.scope = 'section' AND m.section_title = l.section_title)
            OR m.scope = 'course'
          )
        )
        """
    )
    report["lessons_with_visible_materials"] = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM lessons")
    report["lessons_total"] = cur.fetchone()[0]

    resolvable = 0
    for row in rows.values():
        if row.relative_path and (ROOT / row.relative_path).is_file():
            resolvable += 1
    report["planned_resolvable_files"] = resolvable
    report["planned_rows"] = len(rows)

    # Cross-course material claims
    cur.execute(
        """
        SELECT claim_id, COUNT(DISTINCT course_id)
          FROM materials
         WHERE NOT removed AND length(claim_id) > 5
         GROUP BY claim_id
        HAVING COUNT(DISTINCT course_id) > 1
        """
    )
    report["shared_material_claims"] = len(cur.fetchall())

    # Video gates untouched
    cur.execute(
        """
        SELECT count(*) FROM lesson_providers
        WHERE claim_name LIKE '%-doc-%' OR claim_name LIKE '%-doc'
        """
    )
    report["doc_as_video_providers"] = cur.fetchone()[0]
    cur.execute(
        """
        SELECT claim_id FROM lesson_providers lp
        JOIN lessons l ON l.id = lp.lesson_id
        WHERE length(claim_id) > 5
        GROUP BY claim_id
        HAVING count(DISTINCT l.course_id) > 1
        """
    )
    report["shared_video_claims"] = len(cur.fetchall())

    # Per-course coverage sample
    cur.execute(
        """
        SELECT c.id,
          (SELECT COUNT(*) FROM materials m WHERE m.course_id=c.id AND NOT m.removed) mats,
          (SELECT COUNT(*) FROM materials m WHERE m.course_id=c.id AND NOT m.removed AND m.scope='course') course_scope,
          (SELECT COUNT(*) FROM lessons l WHERE l.course_id=c.id AND EXISTS (
             SELECT 1 FROM materials m WHERE m.course_id=l.course_id AND NOT m.removed AND (
               m.lesson_id=l.id OR (m.scope='section' AND m.section_title=l.section_title) OR m.scope='course'
             )
          )) visible_lessons,
          (SELECT COUNT(*) FROM lessons l WHERE l.course_id=c.id) lessons
        FROM courses c
        WHERE c.id NOT LIKE 'fixture%%'
        ORDER BY mats DESC
        """
    )
    report["courses"] = [
        {
            "id": r[0],
            "mats": r[1],
            "course_scope": r[2],
            "visible_lessons": r[3],
            "lessons": r[4],
        }
        for r in cur.fetchall()
    ]
    cur.close()
    conn.close()
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--dsn", default=DEFAULT_DSN)
    parser.add_argument("--skip-sqlite", action="store_true")
    args = parser.parse_args()

    curricula = load_json(CURRICULA_PATH) if CURRICULA_PATH.exists() else []
    docs_manifest = load_json(DOCS_MANIFEST_PATH) if DOCS_MANIFEST_PATH.exists() else {}
    audit = load_json(AUDIT_PATH) if AUDIT_PATH.exists() else []

    conn = psycopg2.connect(args.dsn)
    cur = conn.cursor()
    cur.execute("SELECT id FROM courses WHERE id NOT LIKE 'fixture%'")
    course_ids = {r[0] for r in cur.fetchall()}
    cur.execute("SELECT id, course_id, title, section_title FROM lessons")
    lessons_by_course: dict[str, list[dict]] = defaultdict(list)
    for lid, cid, title, section in cur.fetchall():
        lessons_by_course[cid].append(
            {"id": lid, "title": title or "", "section_title": section or ""}
        )
    cur.close()
    conn.close()

    prefix_by_course = {
        c.get("course_key"): c.get("claim_prefix") for c in curricula if c.get("course_key")
    }

    rows = collect_inventory(
        curricula,
        docs_manifest,
        audit,
        course_ids,
        prefix_by_course,
        lessons_by_course,
    )

    by_course = defaultdict(int)
    scope_counts = defaultdict(int)
    resolvable = 0
    with_claim = 0
    for row in rows.values():
        by_course[row.course_id] += 1
        scope_counts[row.scope] += 1
        if row.relative_path and (ROOT / row.relative_path).is_file():
            resolvable += 1
        if row.claim_id:
            with_claim += 1

    print("=" * 72)
    print("CourseForge materials sync (from scratch)")
    print("=" * 72)
    print(f"  courses in DB     : {len(course_ids)}")
    print(f"  materials planned : {len(rows)}")
    print(f"  resolvable files  : {resolvable}")
    print(f"  with doc claims   : {with_claim}")
    print(f"  scopes            : {dict(scope_counts)}")
    print("  top courses:")
    for course_id, n in sorted(by_course.items(), key=lambda x: -x[1])[:15]:
        print(f"    {n:4d}  {course_id[:64]}")

    if not args.apply:
        print("\nDry-run only. Re-run with --apply to write PostgreSQL (+ SQLite).")
        return 0

    print("\nApplying PostgreSQL materials rebuild…")
    pg_stats = apply_postgres(args.dsn, rows, course_ids)
    print(" ", pg_stats)

    if not args.skip_sqlite:
        print("Applying SQLite course_materials_meta…")
        sq_stats = apply_sqlite(rows, course_ids)
        print(" ", sq_stats)

    report = verify(args.dsn, rows)
    print("\nVerification:")
    print(
        f"  active={report['active_materials']} claims={report['with_claim']} "
        f"planned_resolvable={report['planned_resolvable_files']} "
        f"lessons_visible={report['lessons_with_visible_materials']}/{report['lessons_total']}"
    )
    print(
        f"  gates: doc_as_video={report['doc_as_video_providers']} "
        f"shared_video_claims={report['shared_video_claims']} "
        f"shared_material_claims={report['shared_material_claims']}"
    )
    poor = [
        c
        for c in report["courses"]
        if c["mats"] > 0 and c["lessons"] > 0 and c["visible_lessons"] < max(1, int(c["lessons"] * 0.5))
    ]
    print(f"  courses with <50% lesson material visibility: {len(poor)}")
    for c in poor[:12]:
        print(
            f"    vis={c['visible_lessons']}/{c['lessons']} mats={c['mats']} "
            f"course_scope={c['course_scope']} | {c['id'][:55]}"
        )
    if report["doc_as_video_providers"] or report["shared_video_claims"] or report["shared_material_claims"]:
        print("FAILED video/material isolation gates")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
