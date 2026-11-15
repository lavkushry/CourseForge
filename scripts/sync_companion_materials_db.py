#!/usr/bin/env python3
"""
Synchronize Odysee Manifest claims to:
1. COMPANION_MATERIALS_AUDIT.json (server & local)
2. Remote PostgreSQL 'materials' table on 130.210.19.226
3. Remote & Local SQLite 'course_materials_meta' table
"""
from __future__ import annotations

import json
import sqlite3
import subprocess
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT_DIR / "data/odysee_docs_manifest.json"
if not MANIFEST_PATH.exists():
    MANIFEST_PATH = ROOT_DIR / "odysee_docs_manifest.json"

AUDIT_PATH = ROOT_DIR / "COMPANION_MATERIALS_AUDIT.json"
SQLITE_PATH = ROOT_DIR / "data/courseforge.sqlite3"

# Claim-backed materials with no recoverable local file (abandoned on-chain
# DO447 telegram PDFs/ZIP, or CDN-blocked Sanket notes). Keep removed=true so
# the study rail does not offer broken downloads; do not invent placeholder files.
UNAVAILABLE_MATERIAL_CLAIMS = frozenset(
    {
        "vimal-ansible-do447-2026-res-01-summary-session-1-18-12-2022-pdf",
        "vimal-ansible-do447-2026-res-02-summary-session-2-25-dec-2022-pdf",
        "vimal-ansible-do447-2026-res-03-summary-session-3-pdf",
        "vimal-ansible-do447-2026-res-04-summary-session-4-pdf",
        "vimal-ansible-do447-2026-res-05-ansible-do447-session-05-docx-pdf",
        "vimal-ansible-do447-2026-res-06-session-7-advanced-ansible-02-pdf",
        "vimal-ansible-do447-2026-res-07-session-8-advanced-ansible-03-pdf",
        "vimal-ansible-do447-2026-res-08-session-9-summary-ansible-18th-marc",
        "vimal-ansible-do447-2026-res-09-session-10-summary-ansible-19th-mar",
        "vimal-ansible-do447-2026-res-10-ansible-tower-training-2022-zip",
        "vimal-ansible-do447-2026-res-11-practice-set-for-do447-pdf",
        "vimal-ansible-do447-2026-res-12-advanced-ansible-02-pdf",
        "vimal-ansible-do447-2026-res-13-advanced-ansible-03-pdf",
        "sanket-sd2-2026-357-notes",
    }
)


def sync_manifest_to_audit():
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    with open(AUDIT_PATH, "r", encoding="utf-8") as f:
        audit = json.load(f)

    updated_count = 0
    for item in audit:
        key = f"{item['course_id']}/{item['filename']}"
        if key in manifest and isinstance(manifest[key], dict):
            m_entry = manifest[key]
            claim_id = m_entry.get("claim_id")
            claim_name = m_entry.get("claim_name")
            if claim_id and item.get("current_claim_id") != claim_id:
                item["current_claim_id"] = claim_id
                if claim_name:
                    item["current_claim_name"] = claim_name
                updated_count += 1

    if updated_count:
        with open(AUDIT_PATH, "w", encoding="utf-8") as f:
            json.dump(audit, f, indent=2, ensure_ascii=False)


def sync_to_postgres():
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    sql_statements = ["BEGIN;"]
    for key, entry in manifest.items():
        if not isinstance(entry, dict):
            continue
        course_raw = entry.get("course") or entry.get("course_key") or ""
        name_raw = entry.get("name") or entry.get("filename") or ""
        claim_name_raw = entry.get("claim_name") or ""
        claim_id_raw = entry.get("claim_id") or ""
        if not course_raw or not name_raw or not claim_name_raw or not claim_id_raw:
            continue
        course = course_raw.replace("'", "''")
        name = name_raw.replace("'", "''")
        claim_name = claim_name_raw.replace("'", "''")
        claim_id = claim_id_raw.replace("'", "''")
        unavailable = claim_name_raw in UNAVAILABLE_MATERIAL_CLAIMS
        if unavailable:
            # Keep claim metadata for later restore, but hide broken downloads.
            sql = (
                f"UPDATE materials SET claim_name = '{claim_name}', claim_id = '{claim_id}', "
                f"removed = TRUE, updated_at = NOW() "
                f"WHERE (course_id = '{course}' AND filename = '{name}') "
                f"OR claim_name = '{claim_name}';"
            )
        else:
            sql = (
                f"UPDATE materials SET claim_name = '{claim_name}', claim_id = '{claim_id}', "
                f"removed = FALSE, updated_at = NOW() "
                f"WHERE course_id = '{course}' AND filename = '{name}' "
                f"AND claim_name NOT IN ({','.join(repr(c) for c in sorted(UNAVAILABLE_MATERIAL_CLAIMS))});"
            )
        sql_statements.append(sql)
    # Belt-and-suspenders: always soft-remove denylisted claims by claim_name.
    for claim in sorted(UNAVAILABLE_MATERIAL_CLAIMS):
        c = claim.replace("'", "''")
        sql_statements.append(
            f"UPDATE materials SET removed = TRUE, updated_at = NOW() WHERE claim_name = '{c}';"
        )
    sql_statements.append("COMMIT;")

    full_sql = "\n".join(sql_statements)
    proc = subprocess.run(
        ["docker", "exec", "-i", "courseforge-rewrite-postgres-1", "psql", "-U", "courseforge", "-d", "courseforge_rewrite"],
        input=full_sql,
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"PostgreSQL update failed: {proc.stderr}")


def sync_to_sqlite():
    if not SQLITE_PATH.exists():
        return
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    conn = sqlite3.connect(SQLITE_PATH)
    cur = conn.cursor()
    for key, entry in manifest.items():
        if not isinstance(entry, dict):
            continue
        course = entry.get("course") or entry.get("course_key") or ""
        name = entry.get("name") or entry.get("filename") or ""
        claim_name = entry.get("claim_name") or ""
        claim_id = entry.get("claim_id") or ""
        if not course or not name or not claim_name or not claim_id:
            continue
        removed = 1 if claim_name in UNAVAILABLE_MATERIAL_CLAIMS else 0
        cur.execute(
            "UPDATE course_materials_meta SET removed = ? WHERE course = ? AND filename = ?;",
            (removed, course, name),
        )
    conn.commit()
    conn.close()


def main():
    sync_manifest_to_audit()
    sync_to_postgres()
    sync_to_sqlite()


if __name__ == "__main__":
    main()
