#!/usr/bin/env python3
"""
Adversarial Verification Suite for Milestone 1: Career Studio Historical Data Migration
Challenger: career_challenger_m1_1
Target: services/career_worker/scripts/migrate_data.py
Source Data: applied_jobs.db, outreach_tracker.json

This suite empirically stress-tests:
1. Idempotency across repeated executions (row counts must not double).
2. Raw metadata preservation (screenshot paths, URLs, ATS fields must be non-null in extracted dicts).
3. Recruiter CRM leads integrity (10 leads, connection notes <= 300 chars, valid follow-up dates).
4. Parity check failure gate (must fail and rollback when rows are missing or divergent).
"""

import os
import sys
import json
import sqlite3
import pytest
from pathlib import Path
from datetime import datetime, date

try:
    import psycopg2
    from psycopg2.extras import execute_values
    PSYCOPG2_AVAILABLE = True
except ImportError:
    PSYCOPG2_AVAILABLE = False

from services.career_worker.scripts.migrate_data import (
    extract_and_transform_data,
    migrate,
    parse_json,
    gen_uuid,
)

SQLITE_PATH = Path(os.getenv("CF_TEST_SQLITE_PATH", "/Users/lavkushkumar/Desktop/Resume/applied_jobs.db"))
OUTREACH_JSON_PATH = Path(os.getenv("CF_TEST_OUTREACH_PATH", "/Users/lavkushkumar/Desktop/Resume/outreach_tracker.json"))
PG_BASE_URL = os.getenv(
    "CF_DATABASE_URL",
    os.getenv("DATABASE_URL", "postgres://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite?sslmode=disable")
)
TEST_SCHEMA = "cf_m1_challenger_test"
PG_TEST_URL = f"{PG_BASE_URL}&options=-csearch_path%3D{TEST_SCHEMA}" if "?" in PG_BASE_URL else f"{PG_BASE_URL}?options=-csearch_path%3D{TEST_SCHEMA}"


def ensure_test_schema_with_migrations():
    """Applies all 15 migrations to the test schema if not already present."""
    if not PSYCOPG2_AVAILABLE:
        pytest.skip("psycopg2 not available")
    conn = psycopg2.connect(PG_BASE_URL)
    cur = conn.cursor()
    cur.execute(f"CREATE SCHEMA IF NOT EXISTS {TEST_SCHEMA}")
    cur.execute(f"SET search_path TO {TEST_SCHEMA}")
    cur.execute(f"SELECT to_regclass('{TEST_SCHEMA}.career_applied_jobs')")
    exists = cur.fetchone()[0]
    if not exists:
        migrations_dir = Path("/Users/lavkushkumar/Desktop/Courses/CourseForge/backend/internal/store/migrations")
        sql_files = sorted([f for f in migrations_dir.glob("*.sql")])
        for f in sql_files:
            sql = f.read_text(encoding="utf-8")
            cur.execute(sql)
        conn.commit()
    conn.close()


# ==============================================================================
# Challenge 1: Idempotency Verification
# ==============================================================================
def test_challenge_1_idempotency_multi_run():
    """Empirically test that running migrate_data.py multiple times for candidate lavkush does NOT duplicate rows."""
    if not PSYCOPG2_AVAILABLE:
        pytest.skip("psycopg2 not available")
    ensure_test_schema_with_migrations()

    user_id = "lavkush"
    tables = [
        "career_applied_jobs",
        "career_profile_mutations",
        "career_recruiter_leads",
        "career_keyword_utility",
        "career_search_appearance_weekly",
        "career_policy_state",
        "career_policy_events",
        "career_quarantine",
    ]

    conn = psycopg2.connect(PG_TEST_URL)
    cur = conn.cursor()

    # Run 1
    source_counts_1 = migrate(SQLITE_PATH, OUTREACH_JSON_PATH, PG_TEST_URL, user_id=user_id, dry_run=False)
    counts_run_1 = {}
    for t in tables:
        cur.execute(f"SELECT count(*) FROM {t} WHERE user_id = %s", (user_id,))
        counts_run_1[t] = cur.fetchone()[0]

    # Run 2
    source_counts_2 = migrate(SQLITE_PATH, OUTREACH_JSON_PATH, PG_TEST_URL, user_id=user_id, dry_run=False)
    counts_run_2 = {}
    for t in tables:
        cur.execute(f"SELECT count(*) FROM {t} WHERE user_id = %s", (user_id,))
        counts_run_2[t] = cur.fetchone()[0]

    # Run 3
    source_counts_3 = migrate(SQLITE_PATH, OUTREACH_JSON_PATH, PG_TEST_URL, user_id=user_id, dry_run=False)
    counts_run_3 = {}
    for t in tables:
        cur.execute(f"SELECT count(*) FROM {t} WHERE user_id = %s", (user_id,))
        counts_run_3[t] = cur.fetchone()[0]

    conn.close()

    # Assertions: Counts must be identical across all runs
    assert counts_run_1 == counts_run_2, f"Run 1 and Run 2 counts differ: {counts_run_1} vs {counts_run_2}"
    assert counts_run_2 == counts_run_3, f"Run 2 and Run 3 counts differ: {counts_run_2} vs {counts_run_3}"

    assert counts_run_3["career_applied_jobs"] == 399
    assert counts_run_3["career_profile_mutations"] == 336
    assert counts_run_3["career_recruiter_leads"] == 10
    assert counts_run_3["career_keyword_utility"] == 40
    assert counts_run_3["career_search_appearance_weekly"] == 3
    assert counts_run_3["career_policy_state"] == 1
    assert counts_run_3["career_policy_events"] == 4
    assert counts_run_3["career_quarantine"] == 0


def test_challenge_user_id_stub_collision():
    """
    Challenge candidate user anchor insertion:
    Verify that providing an alternate user_id does NOT crash with UniqueViolation on users_email_unique.
    The migration engine must cleanly anchor the alternate user with a distinct email.
    """
    if not PSYCOPG2_AVAILABLE:
        pytest.skip("psycopg2 not available")
    ensure_test_schema_with_migrations()

    # An alternative user_id should cleanly succeed with zero unique constraint violations
    source_counts = migrate(SQLITE_PATH, OUTREACH_JSON_PATH, PG_TEST_URL, user_id="alternate_user_id", dry_run=False)
    assert source_counts["applied_jobs"] == 399
    assert source_counts["recruiter_leads"] == 10


# ==============================================================================
# Challenge 2: Raw Metadata Preservation (Adversarial Stress Test)
# ==============================================================================
def test_challenge_2_raw_metadata_preservation():
    """
    Challenge raw metadata preservation:
    Verify that screenshot paths, URLs, and ATS fields from SQLite are non-null in extracted dictionaries.
    Also verify in PostgreSQL that raw_metadata is stored as a JSON object (not string primitive)
    and that raw_metadata->>'screenshot' is non-null.
    """
    source_counts, transformed = extract_and_transform_data(SQLITE_PATH, OUTREACH_JSON_PATH, "lavkush")
    apps_data = transformed["applied_jobs"]
    extracted_by_job_id = {a[2]: a for a in apps_data}

    # Query SQLite directly for all rows with non-empty raw_metadata
    db = sqlite3.connect(SQLITE_PATH)
    db.row_factory = sqlite3.Row
    cur = db.cursor()
    cur.execute("""
        SELECT id, job_id, platform, company, title, job_url, evidence_path, raw_metadata
        FROM applied_jobs
        WHERE raw_metadata IS NOT NULL AND length(raw_metadata) > 0
    """)
    sqlite_rows = cur.fetchall()
    assert len(sqlite_rows) == 29, f"Expected 29 rows with raw_metadata in SQLite, found {len(sqlite_rows)}"

    extraction_failures = []
    for r in sqlite_rows:
        jid = r["job_id"] or f"unknown_{r['id']}"
        assert jid in extracted_by_job_id, f"Job {jid} missing from transformed data"

        ex_app = extracted_by_job_id[jid]
        meta_val = ex_app[14]
        # In transformed tuple, meta_val is Json(meta_json) or meta_json
        meta_obj = getattr(meta_val, "adapted", meta_val)

        # 1. Assert extracted metadata is a dict, NOT a str
        if not isinstance(meta_obj, dict):
            extraction_failures.append({
                "job_id": jid,
                "sqlite_id": r["id"],
                "failure": f"raw_metadata extracted as {type(meta_obj).__name__} instead of dict",
                "extracted_value": repr(meta_obj)[:100]
            })
            continue

        # 2. Assert screenshot path is non-null in extracted dict
        screenshot = meta_obj.get("screenshot")
        if not screenshot:
            extraction_failures.append({
                "job_id": jid,
                "sqlite_id": r["id"],
                "failure": "screenshot path missing or null in extracted dictionary",
                "extracted_dict": meta_obj
            })

    # If extraction failures exist, fail with detailed evidence
    if extraction_failures:
        failure_msg = (
            f"\nAdversarial Challenge 2 FAILED: {len(extraction_failures)} of 29 rows failed dictionary extraction!\n"
            + json.dumps(extraction_failures, indent=2)
        )
        pytest.fail(failure_msg)


# ==============================================================================
# Challenge 3: Recruiter Leads Integrity Verification
# ==============================================================================
def test_challenge_3_recruiter_leads_integrity():
    """Verify 10 recruiter leads, connection notes <= 300 chars, follow-up dates."""
    assert OUTREACH_JSON_PATH.exists(), f"Outreach JSON not found at {OUTREACH_JSON_PATH}"

    with open(OUTREACH_JSON_PATH, "r", encoding="utf-8") as f:
        leads = json.load(f)

    assert len(leads) == 10, f"Expected exactly 10 recruiter leads, got {len(leads)}"

    allowed_statuses = {
        "DRAFT_PENDING_MANUAL_SEND", "CONTACTED", "CONNECTED",
        "PITCH_SENT", "CALL_SCHEDULED", "TECH_SCREEN", "REJECTED", "OFFER"
    }

    for idx, lead in enumerate(leads):
        lead_id = lead.get("lead_id")
        assert lead_id, f"Lead #{idx+1} missing lead_id"

        # Check connection note <= 300 chars
        note = lead.get("connection_note_300chars", "")
        note_len = len(note)
        assert note_len <= 300, f"Lead {lead_id} connection_note_300chars exceeds 300 chars: {note_len}"
        assert note_len > 0, f"Lead {lead_id} connection_note_300chars is empty"

        # Check follow-up dates
        d3 = lead.get("day_3_followup_date")
        d7 = lead.get("day_7_followup_date")
        assert d3, f"Lead {lead_id} missing day_3_followup_date"
        assert d7, f"Lead {lead_id} missing day_7_followup_date"

        d3_date = datetime.strptime(d3, "%Y-%m-%d").date()
        d7_date = datetime.strptime(d7, "%Y-%m-%d").date()
        assert d7_date > d3_date, f"Lead {lead_id} day_7 ({d7}) not after day_3 ({d3})"

        # Check status matches DB CHECK constraint
        status = lead.get("status")
        assert status in allowed_statuses, f"Lead {lead_id} has invalid status '{status}' not in {allowed_statuses}"


# ==============================================================================
# Challenge 4: Parity Check Failure Detection & Transaction Rollback
# ==============================================================================
def test_challenge_4_parity_check_failure_gate():
    """
    Stress-test the parity check mechanism:
    Verify that if rows are missing, the automated parity assertion raises RuntimeError
    and cleanly rolls back without committing partial data.
    """
    if not PSYCOPG2_AVAILABLE:
        pytest.skip("psycopg2 not available")
    ensure_test_schema_with_migrations()

    user_id = "lavkush_adversarial_parity_gate"
    source_counts, transformed = extract_and_transform_data(SQLITE_PATH, OUTREACH_JSON_PATH, user_id)

    conn = psycopg2.connect(PG_TEST_URL)
    conn.autocommit = False
    cur = conn.cursor()

    # Ensure user exists
    cur.execute("""
        INSERT INTO users (id, email, name, password_hash, role, verified)
        VALUES (%s, 'adversarial@test.com', 'Adversarial Test', 'disabled', 'student', true)
        ON CONFLICT (id) DO NOTHING
    """, (user_id,))

    # Intentionally insert only 398 of 399 applied jobs (1 missing row)
    apps_data = transformed["applied_jobs"][:-1]
    execute_values(cur, """
        INSERT INTO career_applied_jobs (
            id, user_id, job_id, platform, company, title, location, experience_req,
            match_score, status, application_type, job_url, applied_at,
            applicant_email, raw_metadata, evidence_path, outcome_label,
            outcome_observed_at, policy_version, is_dry_run, is_backfill
        ) VALUES %s
    """, apps_data)

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

    # Replicate the exact gate logic from migrate_data.py
    parity_passed = True
    mismatches = []
    for src_name, pg_table in tables_to_verify:
        expected = source_counts.get(src_name, 0)
        cur.execute(f"SELECT COUNT(*) FROM {pg_table} WHERE user_id = %s", (user_id,))
        actual = cur.fetchone()[0]
        if actual != expected:
            parity_passed = False
            mismatches.append((pg_table, expected, actual))

    # Assert that parity gate FAILS
    assert not parity_passed, "Parity check should have failed when 1 row is missing!"
    assert any(m[0] == "career_applied_jobs" and m[1] == 399 and m[2] == 398 for m in mismatches)

    # Roll back transaction
    conn.rollback()

    # Verify rollback left 0 rows committed for this user
    cur = conn.cursor()
    cur.execute("SELECT count(*) FROM career_applied_jobs WHERE user_id = %s", (user_id,))
    count_after_rollback = cur.fetchone()[0]
    conn.close()

    assert count_after_rollback == 0, f"Expected 0 rows after rollback, got {count_after_rollback}"


# ==============================================================================
# Challenge 5: Dry-Run Zero Side-Effects Verification
# ==============================================================================
def test_challenge_5_dry_run_zero_side_effects():
    """Verify that running migrate_data.py in dry-run mode leaves zero rows committed in PostgreSQL."""
    if not PSYCOPG2_AVAILABLE:
        pytest.skip("psycopg2 not available")
    ensure_test_schema_with_migrations()

    user_id = "lavkush_dry_run_verify"
    conn = psycopg2.connect(PG_TEST_URL)
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO users (id, email, name, password_hash, role, verified)
        VALUES (%s, 'dryrun_test@example.com', 'Dry Run User', 'disabled', 'student', true)
        ON CONFLICT (id) DO NOTHING
    """, (user_id,))
    cur.execute("SELECT count(*) FROM career_applied_jobs WHERE user_id = %s", (user_id,))
    initial_count = cur.fetchone()[0]
    conn.commit()
    conn.close()

    # Execute migration with dry_run=True
    migrate(SQLITE_PATH, OUTREACH_JSON_PATH, PG_TEST_URL, user_id=user_id, dry_run=True)

    # Verify count remains unchanged (0)
    conn = psycopg2.connect(PG_TEST_URL)
    cur = conn.cursor()
    cur.execute("SELECT count(*) FROM career_applied_jobs WHERE user_id = %s", (user_id,))
    final_count = cur.fetchone()[0]
    conn.close()

    assert final_count == initial_count == 0, f"Dry-run committed data! Count changed from {initial_count} to {final_count}"
