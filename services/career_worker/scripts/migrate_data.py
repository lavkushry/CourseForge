#!/usr/bin/env python3
"""
CourseForge Career Studio - Historical Data Migration Utility
Migrates legacy SQLite databases (applied_jobs.db) and JSON trackers (outreach_tracker.json)
into CourseForge PostgreSQL (courseforge_rewrite) with 100% idempotency and row parity verification.
"""

import os
import sys
import json
import uuid
import sqlite3
import argparse
import logging
from pathlib import Path
from datetime import datetime

try:
    import psycopg2
    from psycopg2.extras import execute_values, Json
    PSYCOPG2_AVAILABLE = True
except ImportError:
    PSYCOPG2_AVAILABLE = False

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("MigrateCareerData")

# Deterministic UUID Namespace for CourseForge Career Studio
# Contract: uuid5(NAMESPACE_URL, "courseforge:<table>:<user_id>:<src_id>")
def gen_uuid(table: str, user_id: str, source_id: any) -> str:
    """Generates a deterministic UUIDv5 for tables lacking native unique constraints."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"courseforge:{table}:{user_id}:{source_id}"))

def parse_dt(v):
    """Parses various datetime string formats into timezone-naive datetime objects."""
    if not v:
        return None
    if isinstance(v, datetime):
        return v
    v = str(v).strip()
    if not v:
        return None
    try:
        if len(v) == 10:
            return datetime.strptime(v, "%Y-%m-%d")
        elif len(v) == 16:
            return datetime.strptime(v, "%Y-%m-%d %H:%M")
        elif len(v) == 19:
            return datetime.strptime(v, "%Y-%m-%d %H:%M:%S")
        return datetime.fromisoformat(v)
    except Exception as e:
        logger.warning(f"Failed to parse datetime '{v}': {e}")
        return None

def parse_date(v):
    """Parses date string into a date object."""
    dt = parse_dt(v)
    return dt.date() if dt else None

def parse_json(v, max_depth: int = 5):
    """Safely decodes JSON strings (including double/multi-encoded JSON) or returns empty dict."""
    if not v:
        return {}
    if isinstance(v, (dict, list)):
        return v
    try:
        val = v
        depth = 0
        while isinstance(val, str) and depth < max_depth:
            s = val.strip()
            if not s:
                return {}
            # Allow JSON objects, arrays, or quoted strings (which may contain nested JSON)
            if not (s.startswith('{') or s.startswith('[') or (s.startswith('"') and s.endswith('"'))):
                break
            try:
                val = json.loads(s)
            except (json.JSONDecodeError, ValueError):
                break
            depth += 1
        return val if isinstance(val, (dict, list)) else {}
    except Exception as e:
        logger.warning(f"Failed to parse JSON '{v}': {e}")
        return {}

def extract_and_transform_data(sqlite_path: Path, outreach_json_path: Path, user_id: str):
    """Extracts and transforms records from SQLite and JSON sources into normalized payloads."""
    source_counts = {}
    transformed = {}

    if not sqlite_path.exists():
        logger.warning(f"SQLite database file not found at: {sqlite_path}. Skipping SQLite extraction.")
        return source_counts, transformed

    sq_conn = sqlite3.connect(str(sqlite_path))
    sq_conn.row_factory = sqlite3.Row
    sq_cur = sq_conn.cursor()

    # 1. applied_jobs
    logger.info("[1/8] Extracting applied_jobs from SQLite...")
    sq_cur.execute("""
        SELECT id, job_id, platform, company, title, location, experience_req,
               match_score, status, application_type, job_url, applied_at,
               applicant_email, raw_metadata, evidence_path, outcome_label,
               outcome_observed_at, policy_version, is_backfill
        FROM applied_jobs
    """)
    rows = sq_cur.fetchall()
    source_counts["applied_jobs"] = len(rows)

    apps_data = []
    for r in rows:
        job_id = r["job_id"] or f"unknown_{r['id']}"
        platform = r["platform"] or "naukri"
        status_val = r["status"] or "APPLIED"
        is_dry = bool("DRY_RUN" in status_val.upper())
        meta_json = parse_json(r["raw_metadata"])
        job_uuid = gen_uuid("applied_jobs", user_id, f"{platform}:{job_id}")

        apps_data.append((
            job_uuid,
            user_id,
            job_id,
            platform,
            r["company"] or "Unknown",
            r["title"] or "Azure Data Engineer",
            r["location"] or "",
            r["experience_req"] or "",
            float(r["match_score"] or 70.0),
            status_val,
            r["application_type"] or "1-Click Direct",
            r["job_url"] or "",
            parse_dt(r["applied_at"]) or datetime.now(),
            r["applicant_email"] or "lav84095@gmail.com",
            Json(meta_json) if PSYCOPG2_AVAILABLE else meta_json,
            r["evidence_path"],
            r["outcome_label"],
            parse_dt(r["outcome_observed_at"]),
            r["policy_version"] or "v2.1-linucb",
            is_dry,
            int(r["is_backfill"] or 0)
        ))
    transformed["applied_jobs"] = apps_data

    # 2. profile_mutations
    logger.info("[2/8] Extracting profile_mutations from SQLite...")
    sq_cur.execute("""
        SELECT id, platform, field, old_value, new_value, old_hash, new_hash,
               is_keyword_mutation, mutation_type, rationale, expected_effect,
               approved_by, status, applied_at, reverted_at, metadata
        FROM profile_mutations
    """)
    m_rows = sq_cur.fetchall()
    source_counts["profile_mutations"] = len(m_rows)

    mut_data = []
    for r in m_rows:
        mut_uuid = gen_uuid("profile_mutations", user_id, r["id"])
        meta_json = parse_json(r["metadata"])
        mut_data.append((
            mut_uuid,
            user_id,
            r["platform"] or "naukri",
            r["field"] or "headline",
            r["old_value"],
            r["new_value"] or "",
            r["old_hash"] or "",
            r["new_hash"] or "",
            bool(r["is_keyword_mutation"]),
            r["mutation_type"] or "keyword_injection",
            r["rationale"] or "",
            r["expected_effect"] or "",
            r["approved_by"] or "auto_rule_engine",
            r["status"] or "APPLIED",
            parse_dt(r["applied_at"]) or datetime.now(),
            parse_dt(r["reverted_at"]),
            Json(meta_json) if PSYCOPG2_AVAILABLE else meta_json
        ))
    transformed["profile_mutations"] = mut_data

    # 3. keyword_utility
    logger.info("[3/8] Extracting keyword_utility from SQLite...")
    sq_cur.execute("""
        SELECT token, demand_frequency, saturation_count, utility_score, claimable, updated_at
        FROM keyword_utility
    """)
    k_rows = sq_cur.fetchall()
    source_counts["keyword_utility"] = len(k_rows)

    kw_data = []
    for r in k_rows:
        kw_data.append((
            user_id,
            r["token"],
            int(r["demand_frequency"] or 0),
            int(r["saturation_count"] or 0),
            float(r["utility_score"] or 0.0),
            bool(r["claimable"]),
            parse_dt(r["updated_at"]) or datetime.now()
        ))
    transformed["keyword_utility"] = kw_data

    # 4. search_appearance_weekly
    logger.info("[4/8] Extracting search_appearance_weekly from SQLite...")
    sq_cur.execute("""
        SELECT week_start_date, search_appearances, profile_views, contact_views, recorded_at, platform
        FROM search_appearance_weekly
    """)
    saw_rows = sq_cur.fetchall()
    source_counts["search_appearance_weekly"] = len(saw_rows)

    saw_data = []
    for r in saw_rows:
        saw_data.append((
            user_id,
            r["platform"] or "naukri",
            parse_date(r["week_start_date"]) or datetime.now().date(),
            int(r["search_appearances"] or 0),
            int(r["profile_views"] or 0),
            int(r["contact_views"] or 0),
            parse_dt(r["recorded_at"]) or datetime.now()
        ))
    transformed["search_appearance_weekly"] = saw_data

    # 5. policy_state
    logger.info("[5/8] Extracting policy_state from SQLite...")
    sq_cur.execute("SELECT policy_version, decisions_count, mode, updated_at FROM policy_state LIMIT 1")
    p_row = sq_cur.fetchone()
    source_counts["policy_state"] = 1 if p_row else 0

    if p_row:
        transformed["policy_state"] = (
            user_id,
            p_row["policy_version"] or "v2.1-linucb",
            int(p_row["decisions_count"] or 0),
            p_row["mode"] or "ACTIVE",
            parse_dt(p_row["updated_at"]) or datetime.now()
        )
    else:
        transformed["policy_state"] = None

    # 6. policy_events
    logger.info("[6/8] Extracting policy_events from SQLite...")
    sq_cur.execute("SELECT id, event_type, policy_version, mode, details, created_at FROM policy_events")
    pe_rows = sq_cur.fetchall()
    source_counts["policy_events"] = len(pe_rows)

    pe_data = []
    for r in pe_rows:
        pe_uuid = gen_uuid("policy_events", user_id, r["id"])
        dtl_json = parse_json(r["details"])
        pe_data.append((
            pe_uuid,
            user_id,
            r["event_type"] or "DECISION",
            r["policy_version"] or "v2.1-linucb",
            r["mode"] or "ACTIVE",
            Json(dtl_json) if PSYCOPG2_AVAILABLE else dtl_json,
            parse_dt(r["created_at"]) or datetime.now()
        ))
    transformed["policy_events"] = pe_data

    # 7. quarantine
    logger.info("[7/8] Extracting quarantine from SQLite...")
    sq_cur.execute("""
        SELECT id, category, platform, prompt_text, context_json, status, created_at, resolved_at, resolved_by
        FROM quarantine
    """)
    q_rows = sq_cur.fetchall()
    source_counts["quarantine"] = len(q_rows)

    q_data = []
    for r in q_rows:
        q_uuid = gen_uuid("quarantine", user_id, r["id"])
        ctx_json = parse_json(r["context_json"])
        q_data.append((
            q_uuid,
            user_id,
            r["category"] or "screening_ambiguous",
            r["platform"] or "naukri",
            r["prompt_text"] or "",
            Json(ctx_json) if PSYCOPG2_AVAILABLE else ctx_json,
            r["status"] or "PENDING",
            parse_dt(r["created_at"]) or datetime.now(),
            parse_dt(r["resolved_at"]),
            r["resolved_by"]
        ))
    transformed["quarantine"] = q_data

    sq_cur.close()
    sq_conn.close()

    # 8. recruiter leads from outreach_tracker.json
    source_counts["recruiter_leads"] = 0
    leads_data = []
    if outreach_json_path.exists():
        logger.info(f"[8/8] Extracting recruiter leads from {outreach_json_path}...")
        with open(outreach_json_path, "r", encoding="utf-8") as f:
            leads_json = json.load(f)

        source_counts["recruiter_leads"] = len(leads_json)
        for item in leads_json:
            lead_id = item.get("lead_id")
            lead_uuid = gen_uuid("recruiter_leads", user_id, lead_id)
            leads_data.append((
                lead_uuid,
                user_id,
                lead_id,
                item.get("recruiter_name", "Unknown Recruiter"),
                item.get("company", "Target Company"),
                item.get("target_role", "Azure Data Engineer"),
                item.get("platform", "LinkedIn"),
                item.get("profile_url"),
                item.get("status", "DRAFT_PENDING_MANUAL_SEND"),
                item.get("message_type", "Direct InMail"),
                item.get("message_content", ""),
                item.get("connection_note_300chars", ""),
                parse_date(item.get("day_3_followup_date")),
                item.get("day_3_followup_note", ""),
                parse_date(item.get("day_7_followup_date")),
                item.get("day_7_followup_note", ""),
                item.get("notes", ""),
                parse_dt(item.get("call_scheduled_at")),
                parse_dt(item.get("date")) or datetime.now(),
                parse_dt(item.get("updated_at")) or datetime.now()
            ))
    transformed["recruiter_leads"] = leads_data

    return source_counts, transformed

def migrate(sqlite_path: Path, outreach_json_path: Path, pg_url: str, user_id: str, dry_run: bool = False):
    logger.info("==================================================================")
    logger.info("   CourseForge Career Studio Historical Data Migration Engine     ")
    logger.info("==================================================================")
    logger.info(f"Target User ID   : {user_id}")
    logger.info(f"SQLite Source    : {sqlite_path}")
    logger.info(f"Outreach JSON    : {outreach_json_path}")
    logger.info(f"Dry Run Mode     : {dry_run}")
    sanitized_url = pg_url.split("@")[-1] if "@" in pg_url else pg_url
    logger.info(f"PostgreSQL Target: {sanitized_url}")

    if not sqlite_path.exists():
        logger.warning(f"SQLite database file not found at: {sqlite_path}. Exiting migration cleanly.")
        return {}

    # 1. Extract and transform all data
    source_counts, transformed = extract_and_transform_data(sqlite_path, outreach_json_path, user_id)

    logger.info("------------------------------------------------------------------")
    logger.info("Source Extraction Summary:")
    for entity, count in source_counts.items():
        logger.info(f"  * {entity:<26}: {count} records extracted")
    logger.info("------------------------------------------------------------------")

    # If dry_run and psycopg2 is not available or PG is not reachable, complete dry-run validation
    pg_conn = None
    if not PSYCOPG2_AVAILABLE:
        if not dry_run:
            logger.error("FATAL: psycopg2 library is required for live PostgreSQL migration.")
            sys.exit(1)
        logger.info("psycopg2 is not installed; validated all source transformations in offline dry-run mode.")
        return source_counts

    try:
        pg_conn = psycopg2.connect(pg_url, connect_timeout=5)
    except Exception as e:
        if dry_run:
            logger.info(f"PostgreSQL not reachable at {sanitized_url} ({e}).")
            logger.info("Dry-run data extraction, type parsing, and UUIDv5 mapping verified successfully.")
            return source_counts
        else:
            logger.error(f"FATAL: Unable to connect to PostgreSQL at {sanitized_url}: {e}")
            sys.exit(1)

    pg_conn.autocommit = False
    pg_cur = pg_conn.cursor()

    try:
        # 2. Ensure candidate user exists in users table (foreign key anchor)
        pg_cur.execute("SELECT id, email FROM users WHERE id = %s", (user_id,))
        user_by_id = pg_cur.fetchone()
        if not user_by_id:
            # Derive safe local-part identifier for target user
            clean_uid = "".join(c for c in user_id if c.isalnum() or c in "._-")[:16] or "candidate"
            preferred_email = "lav84095@gmail.com" if user_id == "lavkush" else f"candidate+{clean_uid}@courseforge.internal"

            # Check if preferred_email is already registered to a different user
            pg_cur.execute("SELECT id FROM users WHERE lower(email) = lower(%s)", (preferred_email,))
            user_by_email = pg_cur.fetchone()
            if user_by_email and user_by_email[0] != user_id:
                # Collision detected: assign guaranteed distinct email
                anchor_email = f"candidate+{clean_uid}+{uuid.uuid4().hex[:8]}@courseforge.internal"
                logger.info(
                    f"Email '{preferred_email}' is already registered to user '{user_by_email[0]}'. "
                    f"Assigning distinct anchor email '{anchor_email}' to candidate '{user_id}'."
                )
            else:
                anchor_email = preferred_email

            candidate_name = "Lavkush Kumar" if user_id == "lavkush" else f"Candidate {user_id}"
            logger.info(f"Anchor user '{user_id}' not found; ensuring stub user record in users with email '{anchor_email}'.")
            pg_cur.execute("""
                INSERT INTO users (id, email, name, password_hash, role, verified)
                VALUES (%s, %s, %s, 'disabled', 'student', true)
                ON CONFLICT (id) DO NOTHING
            """, (user_id, anchor_email, candidate_name))
        else:
            logger.info(f"Anchor user '{user_id}' already exists in users (email: {user_by_id[1]}).")

        # 3. Ingest applied_jobs
        apps_data = transformed["applied_jobs"]
        if apps_data:
            execute_values(pg_cur, """
                INSERT INTO career_applied_jobs (
                    id, user_id, job_id, platform, company, title, location, experience_req,
                    match_score, status, application_type, job_url, applied_at,
                    applicant_email, raw_metadata, evidence_path, outcome_label,
                    outcome_observed_at, policy_version, is_dry_run, is_backfill
                ) VALUES %s
                ON CONFLICT (user_id, platform, job_id)
                DO UPDATE SET
                    company = EXCLUDED.company,
                    title = EXCLUDED.title,
                    location = EXCLUDED.location,
                    experience_req = EXCLUDED.experience_req,
                    match_score = EXCLUDED.match_score,
                    status = EXCLUDED.status,
                    application_type = EXCLUDED.application_type,
                    job_url = EXCLUDED.job_url,
                    applied_at = EXCLUDED.applied_at,
                    applicant_email = EXCLUDED.applicant_email,
                    raw_metadata = EXCLUDED.raw_metadata,
                    evidence_path = EXCLUDED.evidence_path,
                    outcome_label = EXCLUDED.outcome_label,
                    outcome_observed_at = EXCLUDED.outcome_observed_at,
                    policy_version = EXCLUDED.policy_version,
                    is_dry_run = EXCLUDED.is_dry_run,
                    is_backfill = EXCLUDED.is_backfill
            """, apps_data)
            logger.info(f" -> Processed {len(apps_data)} applied jobs.")

        # 4. Ingest profile_mutations
        mut_data = transformed["profile_mutations"]
        if mut_data:
            execute_values(pg_cur, """
                INSERT INTO career_profile_mutations (
                    id, user_id, platform, field, old_value, new_value, old_hash, new_hash,
                    is_keyword_mutation, mutation_type, rationale, expected_effect,
                    approved_by, status, applied_at, reverted_at, metadata
                ) VALUES %s
                ON CONFLICT (id)
                DO UPDATE SET
                    old_value = EXCLUDED.old_value,
                    new_value = EXCLUDED.new_value,
                    old_hash = EXCLUDED.old_hash,
                    new_hash = EXCLUDED.new_hash,
                    status = EXCLUDED.status,
                    applied_at = EXCLUDED.applied_at,
                    reverted_at = EXCLUDED.reverted_at,
                    metadata = EXCLUDED.metadata
            """, mut_data)
            logger.info(f" -> Processed {len(mut_data)} profile mutations.")

        # 5. Ingest keyword_utility
        kw_data = transformed["keyword_utility"]
        if kw_data:
            execute_values(pg_cur, """
                INSERT INTO career_keyword_utility (
                    user_id, token, demand_frequency, saturation_count, utility_score, claimable, updated_at
                ) VALUES %s
                ON CONFLICT (user_id, token)
                DO UPDATE SET
                    demand_frequency = EXCLUDED.demand_frequency,
                    saturation_count = EXCLUDED.saturation_count,
                    utility_score = EXCLUDED.utility_score,
                    claimable = EXCLUDED.claimable,
                    updated_at = EXCLUDED.updated_at
            """, kw_data)
            logger.info(f" -> Processed {len(kw_data)} keyword utilities.")

        # 6. Ingest search_appearance_weekly
        saw_data = transformed["search_appearance_weekly"]
        if saw_data:
            execute_values(pg_cur, """
                INSERT INTO career_search_appearance_weekly (
                    user_id, platform, week_start_date, search_appearances, profile_views, contact_views, recorded_at
                ) VALUES %s
                ON CONFLICT (user_id, platform, week_start_date)
                DO UPDATE SET
                    search_appearances = EXCLUDED.search_appearances,
                    profile_views = EXCLUDED.profile_views,
                    contact_views = EXCLUDED.contact_views,
                    recorded_at = EXCLUDED.recorded_at
            """, saw_data)
            logger.info(f" -> Processed {len(saw_data)} weekly search appearance records.")

        # 7. Ingest policy_state
        p_data = transformed["policy_state"]
        if p_data:
            pg_cur.execute("""
                INSERT INTO career_policy_state (user_id, policy_version, decisions_count, mode, updated_at)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (user_id)
                DO UPDATE SET
                    policy_version = EXCLUDED.policy_version,
                    decisions_count = EXCLUDED.decisions_count,
                    mode = EXCLUDED.mode,
                    updated_at = EXCLUDED.updated_at
            """, p_data)
            logger.info(" -> Processed policy state.")

        # 8. Ingest policy_events
        pe_data = transformed["policy_events"]
        if pe_data:
            execute_values(pg_cur, """
                INSERT INTO career_policy_events (
                    id, user_id, event_type, policy_version, mode, details, created_at
                ) VALUES %s
                ON CONFLICT (id)
                DO UPDATE SET
                    event_type = EXCLUDED.event_type,
                    policy_version = EXCLUDED.policy_version,
                    mode = EXCLUDED.mode,
                    details = EXCLUDED.details,
                    created_at = EXCLUDED.created_at
            """, pe_data)
            logger.info(f" -> Processed {len(pe_data)} policy event records.")

        # 9. Ingest quarantine
        q_data = transformed["quarantine"]
        if q_data:
            execute_values(pg_cur, """
                INSERT INTO career_quarantine (
                    id, user_id, category, platform, prompt_text, context_json, status, created_at, resolved_at, resolved_by
                ) VALUES %s
                ON CONFLICT (id)
                DO UPDATE SET
                    category = EXCLUDED.category,
                    platform = EXCLUDED.platform,
                    prompt_text = EXCLUDED.prompt_text,
                    context_json = EXCLUDED.context_json,
                    status = EXCLUDED.status,
                    created_at = EXCLUDED.created_at,
                    resolved_at = EXCLUDED.resolved_at,
                    resolved_by = EXCLUDED.resolved_by
            """, q_data)
            logger.info(f" -> Processed {len(q_data)} quarantine records.")

        # 10. Ingest recruiter leads
        leads_data = transformed["recruiter_leads"]
        if leads_data:
            execute_values(pg_cur, """
                INSERT INTO career_recruiter_leads (
                    id, user_id, lead_id, recruiter_name, company, target_role, platform,
                    profile_url, status, message_type, pitch_text, connection_note_300chars,
                    day_3_followup_date, day_3_followup_note,
                    day_7_followup_date, day_7_followup_note, notes,
                    call_scheduled_at, created_at, updated_at
                ) VALUES %s
                ON CONFLICT (user_id, lead_id)
                DO UPDATE SET
                    recruiter_name = EXCLUDED.recruiter_name,
                    company = EXCLUDED.company,
                    target_role = EXCLUDED.target_role,
                    platform = EXCLUDED.platform,
                    profile_url = EXCLUDED.profile_url,
                    status = EXCLUDED.status,
                    message_type = EXCLUDED.message_type,
                    pitch_text = EXCLUDED.pitch_text,
                    connection_note_300chars = EXCLUDED.connection_note_300chars,
                    day_3_followup_date = EXCLUDED.day_3_followup_date,
                    day_3_followup_note = EXCLUDED.day_3_followup_note,
                    day_7_followup_date = EXCLUDED.day_7_followup_date,
                    day_7_followup_note = EXCLUDED.day_7_followup_note,
                    notes = EXCLUDED.notes,
                    call_scheduled_at = EXCLUDED.call_scheduled_at,
                    updated_at = EXCLUDED.updated_at
            """, leads_data)
            logger.info(f" -> Processed {len(leads_data)} recruiter leads.")

        # --------------------------------------------------------------------------
        # 11. Row Count Parity Verification Gate
        # --------------------------------------------------------------------------
        logger.info("==================================================================")
        logger.info("           VERIFYING POST-MIGRATION ROW COUNT PARITY             ")
        logger.info("==================================================================")

        tables_to_verify = [
            ("applied_jobs", "career_applied_jobs"),
            ("profile_mutations", "career_profile_mutations"),
            ("recruiter_leads", "career_recruiter_leads"),
            ("keyword_utility", "career_keyword_utility"),
            ("search_appearance_weekly", "career_search_appearance_weekly"),
            ("policy_state", "career_policy_state"),
            ("policy_events", "career_policy_events"),
            ("quarantine", "career_quarantine"),
        ]

        parity_passed = True
        for src_name, pg_table in tables_to_verify:
            expected = source_counts.get(src_name, 0)
            pg_cur.execute(f"SELECT COUNT(*) FROM {pg_table} WHERE user_id = %s", (user_id,))
            actual = pg_cur.fetchone()[0]

            match_symbol = "PASS" if actual == expected else "FAIL"
            logger.info(f"[{match_symbol}] {pg_table:<32}: Expected={expected:<4} | Actual={actual:<4}")

            if actual != expected:
                parity_passed = False

        if not parity_passed:
            pg_conn.rollback()
            raise RuntimeError("Row count parity check failed! Data divergence detected.")

        if dry_run:
            logger.info("Dry-run verification completed successfully. Rolling back transaction.")
            pg_conn.rollback()
        else:
            pg_conn.commit()
            logger.info("Transaction committed successfully.")

        logger.info("==================================================================")
        logger.info("   All datasets verified with 100% verified row count parity!     ")
        logger.info("==================================================================")
        return source_counts

    except Exception as e:
        if pg_conn:
            pg_conn.rollback()
        logger.error(f"Migration error: {e}")
        raise
    finally:
        if pg_cur:
            pg_cur.close()
        if pg_conn:
            pg_conn.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CourseForge Career Studio Migration Utility")
    default_sqlite = Path.home() / "Desktop/Resume/applied_jobs.db"
    default_json = Path.home() / "Desktop/Resume/outreach_tracker.json"

    parser.add_argument("--sqlite-db", default=str(default_sqlite), help="Path to applied_jobs.db SQLite file")
    parser.add_argument("--outreach-json", default=str(default_json), help="Path to outreach_tracker.json file")
    parser.add_argument("--pg-url", default=os.getenv(
        "CF_DATABASE_URL",
        os.getenv("DATABASE_URL", "postgres://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite?sslmode=disable")
    ), help="PostgreSQL connection URL")
    parser.add_argument("--user-id", default=os.getenv("CF_CAREER_USER_ID", "lavkush"), help="Target user ID")
    parser.add_argument("--dry-run", action="store_true", help="Perform extraction, transformation, and validation without committing changes")

    args = parser.parse_args()
    try:
        migrate(Path(args.sqlite_db), Path(args.outreach_json), args.pg_url, args.user_id, dry_run=args.dry_run)
    except Exception as err:
        logger.error(f"Execution failed: {err}")
        sys.exit(1)
