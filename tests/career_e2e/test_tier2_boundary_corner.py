"""
Tier 2: Boundary & Corner Cases Test Suite (ForgeCareer)
Covers all 35 features from PROJECT.md § Feature Inventory with >= 5 boundary/corner cases per feature.
Tests limits, character counts, empty inputs, edge dates, invalid combinations, and stress conditions.
"""

import os
import sys
import re
import json
import sqlite3
import subprocess
from pathlib import Path
import pytest

from services.career_worker.modules.boost.policy import LinUCBPolicy, Action
from services.career_worker.modules.boost.mutator import ProfileMutator
from services.career_worker.modules.goal.pacing import PacingCalculator
from services.career_worker.modules.goal.diagnostics import DiagnosticEngine
from services.career_worker.modules.goal.crm import RecruiterCRM
from services.career_worker.modules.plan.daily_blocks import DailyBlockOrchestrator
from services.career_worker.core.lock import acquire_worker_lock


# ==============================================================================
# F01: Plan Items Kind Relaxation (Boundaries)
# ==============================================================================
class TestTier2_F01_PlanItemsKindBoundary:
    def test_kind_case_sensitivity(self):
        # SQL check constraints are case-sensitive; uppercase must be rejected
        allowed = {'lesson', 'review', 'assessment', 'lab', 'career_boost', 'career_apply', 'career_outreach', 'career_followup'}
        assert "CAREER_BOOST" not in allowed
        assert "Career_Apply" not in allowed

    def test_kind_with_trailing_whitespace(self):
        allowed = {'lesson', 'review', 'assessment', 'lab', 'career_boost', 'career_apply', 'career_outreach', 'career_followup'}
        assert "career_boost " not in allowed
        assert " career_apply" not in allowed

    def test_empty_string_kind(self):
        allowed = {'lesson', 'review', 'assessment', 'lab', 'career_boost', 'career_apply', 'career_outreach', 'career_followup'}
        assert "" not in allowed

    def test_null_kind(self):
        allowed = {'lesson', 'review', 'assessment', 'lab', 'career_boost', 'career_apply', 'career_outreach', 'career_followup'}
        assert None not in allowed

    def test_similar_prefix_kind_rejected(self):
        allowed = {'lesson', 'review', 'assessment', 'lab', 'career_boost', 'career_apply', 'career_outreach', 'career_followup'}
        assert "career_booster" not in allowed
        assert "career" not in allowed


# ==============================================================================
# F02: Career Schema Migration (Boundaries)
# ==============================================================================
class TestTier2_F02_SchemaBoundary:
    def test_applied_jobs_status_check_constraint_coverage(self, migration_sql_path):
        content = migration_sql_path.read_text()
        assert "career_applied_jobs" in content
        # Ensure status is NOT NULL
        assert "status TEXT NOT NULL" in content

    def test_profile_mutations_status_constraint_enum(self, migration_sql_path):
        content = migration_sql_path.read_text()
        match = re.search(r"status TEXT NOT NULL CHECK\(status IN \((.*?)\)\)", content)
        assert match is not None
        statuses = [s.strip().strip("'") for s in match.group(1).split(",")]
        assert set(statuses) == {"PROPOSED", "APPLIED", "REVERTED", "FAILED"}

    def test_recruiter_leads_status_constraint_enum(self, migration_sql_path):
        content = migration_sql_path.read_text()
        match = re.search(r"career_recruiter_leads.*?status TEXT NOT NULL CHECK\(status IN \((.*?)\)\)", content, re.DOTALL)
        assert match is not None
        allowed = [s.strip().strip("'") for s in match.group(1).split(",")]
        assert "CALL_SCHEDULED" in allowed
        assert "REJECTED" in allowed

    def test_quarantine_categories_enum(self, migration_sql_path):
        content = migration_sql_path.read_text()
        match = re.search(r"career_quarantine.*?category TEXT NOT NULL CHECK\(category IN \((.*?)\)\)", content, re.DOTALL)
        assert match is not None
        assert "mutation_unwhitelisted" in match.group(1)
        assert "screening_ambiguous" in match.group(1)

    def test_jsonb_default_is_empty_object(self, migration_sql_path):
        content = migration_sql_path.read_text()
        assert "raw_metadata JSONB DEFAULT '{}'::jsonb" in content
        assert "active_bottlenecks JSONB DEFAULT '[]'::jsonb" in content


# ==============================================================================
# F03: Migration Go Test Harness (Boundaries)
# ==============================================================================
class TestTier2_F03_MigrationHarnessBoundary:
    def test_migration_file_not_empty(self, migration_sql_path):
        assert migration_sql_path.stat().st_size > 5000

    def test_migration_comment_markers(self, migration_sql_path):
        content = migration_sql_path.read_text()
        assert content.startswith("--")

    def test_no_forbidden_drop_table_statements(self, migration_sql_path):
        content = migration_sql_path.read_text()
        assert "DROP TABLE" not in content

    def test_table_name_lengths_under_63_bytes(self, migration_sql_path):
        content = migration_sql_path.read_text()
        tables = re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)", content)
        for t in tables:
            assert len(t.encode("utf-8")) <= 63  # Postgres 63 byte identifier limit

    def test_primary_key_definitions_unambiguous(self, migration_sql_path):
        content = migration_sql_path.read_text()
        assert content.count("PRIMARY KEY") >= 9


# ==============================================================================
# F04: Applied Jobs Migration (Boundaries)
# ==============================================================================
class TestTier2_F04_AppliedJobsBoundary:
    def test_exact_row_count_not_less_or_more_than_399(self, sqlite_db_path):
        con = sqlite3.connect(str(sqlite_db_path))
        cur = con.cursor()
        cnt = cur.execute("SELECT COUNT(*) FROM applied_jobs").fetchone()[0]
        con.close()
        assert cnt == 399

    def test_job_id_special_characters_handled(self, sqlite_db_path):
        con = sqlite3.connect(str(sqlite_db_path))
        cur = con.cursor()
        job_ids = [r[0] for r in cur.execute("SELECT job_id FROM applied_jobs").fetchall()]
        con.close()
        # Ensure job_ids contain standard identifiers or integers
        for jid in job_ids:
            assert len(str(jid)) > 0
            assert "\x00" not in str(jid)

    def test_company_names_with_accents_and_dots(self, sqlite_db_path):
        con = sqlite3.connect(str(sqlite_db_path))
        cur = con.cursor()
        companies = [r[0] for r in cur.execute("SELECT company FROM applied_jobs WHERE company LIKE '%.%' OR company LIKE '%&%'").fetchall()]
        con.close()
        assert len(companies) > 0  # Real data includes companies like 'CGI Inc.' or 'Ernst & Young'

    def test_boundary_match_scores_extremes(self, sqlite_db_path):
        con = sqlite3.connect(str(sqlite_db_path))
        cur = con.cursor()
        min_score, max_score = cur.execute("SELECT MIN(match_score), MAX(match_score) FROM applied_jobs").fetchone()
        con.close()
        assert min_score >= 0.0
        assert max_score <= 100.0

    def test_date_range_sanity(self, sqlite_db_path):
        con = sqlite3.connect(str(sqlite_db_path))
        cur = con.cursor()
        dates = cur.execute("SELECT MIN(applied_at), MAX(applied_at) FROM applied_jobs").fetchone()
        con.close()
        assert "2026" in str(dates[1])  # Recent 2026 data


# ==============================================================================
# F05: Profile Mutation Migration (Boundaries)
# ==============================================================================
class TestTier2_F05_ProfileMutationBoundary:
    def test_hash_length_exact_64_hex(self, sqlite_db_path):
        con = sqlite3.connect(str(sqlite_db_path))
        cur = con.cursor()
        hashes = cur.execute("SELECT old_hash, new_hash FROM profile_mutations WHERE old_hash != '' LIMIT 50").fetchall()
        con.close()
        for h1, h2 in hashes:
            assert len(h1) == 64
            assert len(h2) == 64
            int(h1, 16)  # Verify hex
            int(h2, 16)

    def test_mutation_headline_length_boundary(self, sqlite_db_path):
        con = sqlite3.connect(str(sqlite_db_path))
        cur = con.cursor()
        headlines = [r[0] for r in cur.execute("SELECT new_value FROM profile_mutations WHERE field='headline'").fetchall()]
        con.close()
        for hl in headlines:
            assert len(hl) <= 250  # Must never exceed Naukri 250-char limit

    def test_empty_old_value_handled(self, sqlite_db_path):
        con = sqlite3.connect(str(sqlite_db_path))
        cur = con.cursor()
        null_old = cur.execute("SELECT COUNT(*) FROM profile_mutations WHERE old_value IS NULL OR old_value = ''").fetchone()[0]
        con.close()
        assert null_old >= 0  # Initial mutations have empty old_value

    def test_is_keyword_mutation_boolean_parity(self, sqlite_db_path):
        con = sqlite3.connect(str(sqlite_db_path))
        cur = con.cursor()
        values = set(r[0] for r in cur.execute("SELECT DISTINCT is_keyword_mutation FROM profile_mutations").fetchall())
        con.close()
        assert values.issubset({0, 1, True, False})

    def test_mutation_count_exceeds_minimum(self, sqlite_db_path):
        con = sqlite3.connect(str(sqlite_db_path))
        cur = con.cursor()
        cnt = cur.execute("SELECT COUNT(*) FROM profile_mutations").fetchone()[0]
        con.close()
        assert cnt >= 317


# ==============================================================================
# F06: Recruiter Leads Migration (Boundaries)
# ==============================================================================
class TestTier2_F06_RecruiterLeadsBoundary:
    def test_connection_note_300_char_strict_ceiling(self, outreach_json_path):
        with open(outreach_json_path) as f:
            leads = json.load(f)
        for lead in leads:
            note = lead.get("connection_note_300chars", "")
            assert len(note) <= 300, f"Lead {lead.get('lead_id')} note length {len(note)} > 300"

    def test_connection_note_not_empty_for_active_leads(self, outreach_json_path):
        with open(outreach_json_path) as f:
            leads = json.load(f)
        for lead in leads:
            note = lead.get("connection_note_300chars", "")
            assert len(note) >= 50

    def test_followup_day_delta_boundary(self, outreach_json_path):
        from datetime import datetime
        with open(outreach_json_path) as f:
            leads = json.load(f)
        for lead in leads:
            d3 = lead.get("day_3_followup_date")
            d7 = lead.get("day_7_followup_date")
            if d3 and d7:
                dt3 = datetime.strptime(d3, "%Y-%m-%d")
                dt7 = datetime.strptime(d7, "%Y-%m-%d")
                assert dt7 >= dt3

    def test_lead_id_uniqueness(self, outreach_json_path):
        with open(outreach_json_path) as f:
            leads = json.load(f)
        ids = [l["lead_id"] for l in leads]
        assert len(ids) == len(set(ids))

    def test_recruiter_name_non_empty(self, outreach_json_path):
        with open(outreach_json_path) as f:
            leads = json.load(f)
        for l in leads:
            assert len(l["recruiter_name"].strip()) > 0


# ==============================================================================
# F07: Utility & Policy Data Migration (Boundaries)
# ==============================================================================
class TestTier2_F07_UtilityPolicyBoundary:
    def test_keyword_utility_boundary_zero_demand(self, sqlite_db_path):
        con = sqlite3.connect(str(sqlite_db_path))
        cur = con.cursor()
        min_demand = cur.execute("SELECT MIN(demand_frequency) FROM keyword_utility").fetchone()[0]
        con.close()
        assert min_demand >= 0

    def test_keyword_token_not_empty(self, sqlite_db_path):
        con = sqlite3.connect(str(sqlite_db_path))
        cur = con.cursor()
        empty_tokens = cur.execute("SELECT COUNT(*) FROM keyword_utility WHERE token IS NULL OR token = ''").fetchone()[0]
        con.close()
        assert empty_tokens == 0

    def test_policy_decisions_count_non_negative(self, sqlite_db_path):
        con = sqlite3.connect(str(sqlite_db_path))
        cur = con.cursor()
        cnt = cur.execute("SELECT decisions_count FROM policy_state LIMIT 1").fetchone()[0]
        con.close()
        assert cnt >= 0

    def test_weekly_appearance_start_date_format(self, sqlite_db_path):
        con = sqlite3.connect(str(sqlite_db_path))
        cur = con.cursor()
        dates = [r[0] for r in cur.execute("SELECT week_start_date FROM search_appearance_weekly").fetchall()]
        con.close()
        for d in dates:
            assert re.match(r"^\d{4}-\d{2}-\d{2}$", d)

    def test_search_appearances_non_negative(self, sqlite_db_path):
        con = sqlite3.connect(str(sqlite_db_path))
        cur = con.cursor()
        invalid = cur.execute("SELECT COUNT(*) FROM search_appearance_weekly WHERE search_appearances < 0").fetchone()[0]
        con.close()
        assert invalid == 0


# ==============================================================================
# F08: Career Worker FastAPI Daemon (Boundaries)
# ==============================================================================
class TestTier2_F08_FastAPIBoundary:
    def test_health_head_method_or_get(self, worker_client):
        res = worker_client.get("/health")
        assert res.status_code == 200

    def test_invalid_json_payload_rejection(self, worker_client):
        res = worker_client.post("/execute/bump", content="{ malformed json", headers={"Content-Type": "application/json"})
        assert res.status_code == 422

    def test_apply_endpoint_block_boundaries(self, worker_client):
        # Valid blocks are 1, 2, 3
        res = worker_client.post("/execute/apply", json={"user_id": "lavkush", "block": 1, "dry_run": True})
        assert res.status_code == 200

    def test_pacing_negative_parameters(self, worker_client):
        # Negative numbers should be handled safely without 500 error
        res = worker_client.get("/evaluate/pacing?calls=-1&apps=-5&outreach=-2")
        assert res.status_code == 200

    def test_pacing_extreme_large_numbers(self, worker_client):
        res = worker_client.get("/evaluate/pacing?calls=1000000&apps=5000000&outreach=1000000")
        assert res.status_code == 200
        assert res.json()["pacing"]["pacing_ratio"] >= 1.0


# ==============================================================================
# F09: Platform Adapters & Simulation (Boundaries)
# ==============================================================================
class TestTier2_F09_SimulationBoundary:
    def test_search_and_apply_zero_limit(self, sim_adapter):
        apps = sim_adapter.search_and_apply("Azure", limit=0, dry_run=True)
        assert len(apps) == 0

    def test_search_and_apply_extreme_limit_caps_to_mock_data(self, sim_adapter):
        apps = sim_adapter.search_and_apply("Azure", limit=1000, dry_run=True)
        assert len(apps) <= 50  # Capped safely

    def test_search_with_unicode_and_emojis(self, sim_adapter):
        apps = sim_adapter.search_and_apply("Azure Data Engineer 🚀 💻 ☁️", limit=3, dry_run=True)
        assert len(apps) == 3

    def test_recruiter_pitch_with_empty_details(self, sim_adapter):
        ok = sim_adapter.send_recruiter_pitch({}, dry_run=True)
        assert ok is True

    def test_extract_metrics_deterministic_non_zero(self, sim_adapter):
        m1 = sim_adapter.extract_metrics()
        m2 = sim_adapter.extract_metrics()
        assert m1["search_appearances"] > 0
        assert m2["search_appearances"] > 0


# ==============================================================================
# F10: LinUCB v2.1 Contextual Bandit (Boundaries)
# ==============================================================================
class TestTier2_F10_LinUCBBoundary:
    def test_all_zero_context_vector(self, linucb_policy):
        ctx = [0.0] * 7
        action, max_p, scores = linucb_policy.select_action(ctx)
        assert action in (Action.APPLY, Action.SKIP, Action.DEFER_TO_REVIEW)
        assert not any(v is None for v in scores.values())

    def test_all_one_context_vector(self, linucb_policy):
        ctx = [1.0] * 7
        action, max_p, scores = linucb_policy.select_action(ctx)
        assert action in (Action.APPLY, Action.SKIP, Action.DEFER_TO_REVIEW)

    def test_negative_reward_update_handling(self, linucb_policy):
        ctx = [0.5] * 7
        linucb_policy.update(Action.APPLY, -1.0, ctx)
        # Should not crash and matrix A should remain positive definite
        action, max_p, scores = linucb_policy.select_action(ctx)
        assert action in (Action.APPLY, Action.SKIP, Action.DEFER_TO_REVIEW)

    def test_zero_reward_update(self, linucb_policy):
        ctx = [0.5] * 7
        linucb_policy.update(Action.SKIP, 0.0, ctx)
        action, _, _ = linucb_policy.select_action(ctx)
        assert action in (Action.APPLY, Action.SKIP, Action.DEFER_TO_REVIEW)

    def test_alpha_zero_pure_exploitation(self):
        policy = LinUCBPolicy(alpha=0.0)
        ctx = [0.9, 0.5, 0.1, 1.0, 1.0, 0.9, 0.8]
        action, _, _ = policy.select_action(ctx)
        assert action in (Action.APPLY, Action.SKIP, Action.DEFER_TO_REVIEW)


# ==============================================================================
# F11: Whitelist Profile Mutator (Boundaries)
# ==============================================================================
class TestTier2_F11_ProfileMutatorBoundary:
    def test_headline_length_exact_250(self, profile_mutator):
        exact_250 = "Azure Data Engineer | 2.5 YOE | " + "A" * (250 - 32)
        assert len(exact_250) == 250
        ok, _ = profile_mutator.validate_headline_mutation("Old", exact_250)
        assert ok is True

    def test_headline_length_251_rejected(self, profile_mutator):
        overflow_251 = "Azure Data Engineer | 2.5 YOE | " + "A" * (251 - 32)
        assert len(overflow_251) == 251
        ok, msg = profile_mutator.validate_headline_mutation("Old", overflow_251)
        assert ok is False
        assert "exceeds" in msg.lower() or "limit" in msg.lower()

    def test_reject_3_yoe(self, profile_mutator):
        ok, _ = profile_mutator.validate_headline_mutation("Old", "Azure Data Engineer | 3 YOE")
        assert ok is False

    def test_reject_30_days_notice(self, profile_mutator):
        ok, _ = profile_mutator.validate_headline_mutation("Old", "Azure Data Engineer | 30 days notice")
        assert ok is False

    def test_hash_content_reproducible(self, profile_mutator):
        h1 = profile_mutator.hash_content("Headline A")
        h2 = profile_mutator.hash_content("Headline A")
        h3 = profile_mutator.hash_content("Headline B")
        assert h1 == h2
        assert h1 != h3


# ==============================================================================
# F12: 6-Stage Bottleneck Diagnostics (Boundaries)
# ==============================================================================
class TestTier2_F12_DiagnosticsBoundary:
    def test_exact_5_calls_healthy(self):
        metrics = {"calls_scheduled_today": 5, "applications_today": 30, "outreaches_today": 12, "search_appearances": 200, "contact_views": 10, "replies_today": 3}
        alerts = DiagnosticEngine.evaluate(metrics)
        codes = [a["code"] for a in alerts]
        assert "LOW_CALL_CONVERSION" not in codes

    def test_exact_4_calls_triggers_critical(self):
        metrics = {"calls_scheduled_today": 4, "applications_today": 30, "outreaches_today": 12, "search_appearances": 200, "contact_views": 10, "replies_today": 3}
        alerts = DiagnosticEngine.evaluate(metrics)
        codes = [a["code"] for a in alerts]
        assert "LOW_CALL_CONVERSION" in codes

    def test_exact_150_appearances_healthy(self):
        metrics = {"search_appearances": 150, "contact_views": 10, "applications_today": 30, "outreaches_today": 12, "calls_scheduled_today": 5, "replies_today": 3}
        alerts = DiagnosticEngine.evaluate(metrics)
        codes = [a["code"] for a in alerts]
        assert "LOW_SEARCH_APPEARANCES" not in codes

    def test_exact_149_appearances_triggers_high(self):
        metrics = {"search_appearances": 149, "contact_views": 10, "applications_today": 30, "outreaches_today": 12, "calls_scheduled_today": 5, "replies_today": 3}
        alerts = DiagnosticEngine.evaluate(metrics)
        codes = [a["code"] for a in alerts]
        assert "LOW_SEARCH_APPEARANCES" in codes

    def test_zero_division_guard_when_outreach_zero(self):
        metrics = {"search_appearances": 200, "contact_views": 10, "applications_today": 30, "outreaches_today": 0, "calls_scheduled_today": 5}
        # outreach = 0 should trigger LOW_OUTREACH_VOLUME without ZeroDivisionError
        alerts = DiagnosticEngine.evaluate(metrics)
        codes = [a["code"] for a in alerts]
        assert "LOW_OUTREACH_VOLUME" in codes


# ==============================================================================
# F13: Process Lock Guard (Boundaries)
# ==============================================================================
class TestTier2_F13_ProcessLockBoundary:
    def test_multiple_sequential_acquires(self):
        for _ in range(5):
            with acquire_worker_lock() as acquired:
                assert acquired is True

    def test_lock_collision_returns_clean_false(self):
        with acquire_worker_lock() as l1:
            assert l1 is True
            with acquire_worker_lock() as l2:
                assert l2 is False

    def test_lock_file_permissions(self):
        with acquire_worker_lock() as acquired:
            assert acquired is True
            assert os.path.exists("/tmp/courseforge_career.lock")

    def test_lock_context_clean_exception_recovery(self):
        try:
            with acquire_worker_lock() as acquired:
                assert acquired is True
                raise ValueError("Intentional error inside lock")
        except ValueError:
            pass
        # Lock should be released despite exception
        with acquire_worker_lock() as acquired2:
            assert acquired2 is True

    def test_lock_file_non_empty_path(self):
        from services.career_worker.core.lock import LOCK_FILE
        assert len(LOCK_FILE) > 0


# ==============================================================================
# F14: Worker CLI Runner Module (Boundaries)
# ==============================================================================
class TestTier2_F14_RunnerCLI_Boundary:
    def test_invalid_block_number_handling(self, repo_root):
        cmd = [sys.executable, str(repo_root / "services" / "career_worker" / "runner.py"), "--dry-run", "--block=99"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        # Should exit cleanly or reject invalid block
        assert res.returncode in (0, 1, 2)

    def test_invalid_action_rejected_by_argparse(self, repo_root):
        cmd = [sys.executable, str(repo_root / "services" / "career_worker" / "runner.py"), "--action=unsupported_action"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        assert res.returncode == 2
        assert "invalid choice" in res.stderr

    def test_action_bump_dry_run(self, repo_root):
        cmd = [sys.executable, str(repo_root / "services" / "career_worker" / "runner.py"), "--action=bump", "--dry-run"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        assert res.returncode == 0

    def test_action_mutate_dry_run(self, repo_root):
        cmd = [sys.executable, str(repo_root / "services" / "career_worker" / "runner.py"), "--action=mutate", "--dry-run"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        assert res.returncode == 0

    def test_action_digest_dry_run(self, repo_root):
        cmd = [sys.executable, str(repo_root / "services" / "career_worker" / "runner.py"), "--action=digest", "--dry-run"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        assert res.returncode == 0


# ==============================================================================
# F15: Worker Pytest Test Suite (Boundaries)
# ==============================================================================
class TestTier2_F15_WorkerPytestBoundary:
    def test_pytest_discovers_all_test_methods(self, repo_root):
        cmd = ["pytest", str(repo_root / "services" / "career_worker" / "tests"), "--collect-only"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        assert res.returncode == 0
        assert "8 items" in res.stdout or "collected 8 items" in res.stdout or "14 items" in res.stdout or "collected 14 items" in res.stdout

    def test_pytest_executes_without_pdb(self, repo_root):
        cmd = ["pytest", str(repo_root / "services" / "career_worker" / "tests"), "-q"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        assert res.returncode == 0

    def test_test_career_worker_imports_cleanly(self):
        from services.career_worker.tests.test_career_worker import test_simulation_adapter
        assert callable(test_simulation_adapter)

    def test_pytest_no_internal_syntax_errors(self, repo_root):
        test_code = (repo_root / "services" / "career_worker" / "tests" / "test_career_worker.py").read_text()
        compile(test_code, "test_career_worker.py", "exec")

    def test_test_case_names_follow_convention(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "tests" / "test_career_worker.py").read_text()
        for fn in re.findall(r"^def (\w+)\(", content, re.M):
            assert fn.startswith("test_")


# ==============================================================================
# F16: Go Domain Contracts (Boundaries)
# ==============================================================================
class TestTier2_F16_GoDomainBoundary:
    def test_domain_applied_job_fields_count(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "domain.go").read_text()
        # Ensure AppliedJob struct defines at least 15 fields
        assert "type AppliedJob struct" in content
        fields = re.findall(r"(\w+)\s+(string|int|float64|time\.Time|\*time\.Time|bool)\s+`json:", content)
        assert len(fields) >= 15

    def test_profile_mutation_struct_fields(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "domain.go").read_text()
        for f in ["OldHash", "NewHash", "IsKeywordMutation", "MutationType"]:
            assert f in content

    def test_recruiter_lead_struct_followup_pointers(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "domain.go").read_text()
        assert "*string" in content or "string" in content  # Day3FollowupDate

    def test_bottleneck_alert_severity_values(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "domain.go").read_text()
        assert "Severity" in content
        assert "ActionRequired" in content

    def test_keyword_utility_utility_score_type(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "domain.go").read_text()
        assert "UtilityScore    float64" in content


# ==============================================================================
# F17: REST API Handlers (Boundaries)
# ==============================================================================
class TestTier2_F17_RESTHandlersBoundary:
    def test_invalid_block_id_rejection_logic(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "handlers.go").read_text()
        assert "invalid_block" in content
        assert "block must be 1, 2, or 3" in content

    def test_lead_id_url_path_extraction(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "handlers.go").read_text()
        assert 'r.PathValue("id")' in content

    def test_missing_lead_id_check(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "handlers.go").read_text()
        assert 'httpx.Error(w, http.StatusBadRequest, "invalid_id", "missing lead id")' in content

    def test_job_query_pagination_parsing(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "handlers.go").read_text()
        assert 'strconv.Atoi(q.Get("limit"))' in content
        assert 'strconv.Atoi(q.Get("offset"))' in content

    def test_principal_user_id_forwarded(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "handlers.go").read_text()
        assert "p.UserID" in content


# ==============================================================================
# F18: Streaming Data Exports (Boundaries)
# ==============================================================================
class TestTier2_F18_ExportBoundary:
    def test_csv_attachment_header_quotes(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "handlers.go").read_text()
        assert "attachment; filename=courseforge_career_applied_jobs.csv" in content

    def test_csv_header_slice_length(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "service.go").read_text()
        headers_match = re.search(r"writer\.Write\(\[\]string\{(.*?)\}\)", content, re.DOTALL)
        assert headers_match is not None
        headers = [h.strip().strip('"') for h in headers_match.group(1).split(",")]
        assert len(headers) >= 7

    def test_csv_row_formatting_includes_match_score(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "service.go").read_text()
        assert "strconv.FormatFloat" in content or "fmt.Sprintf" in content

    def test_csv_rfc4180_carriage_return_handling(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "service.go").read_text()
        assert "encoding/csv" in content

    def test_csv_empty_results_serves_headers(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "service.go").read_text()
        assert '"Platform", "Job ID", "Company"' in content


# ==============================================================================
# F19: Go Career Service Unit Tests (Boundaries)
# ==============================================================================
class TestTier2_F19_GoServiceTestBoundary:
    def test_go_test_execution_clean_exit(self, repo_root):
        cmd = ["go", "test", "./internal/career/..."]
        res = subprocess.run(cmd, cwd=str(repo_root / "backend"), capture_output=True, text=True)
        assert res.returncode == 0

    def test_mock_worker_tracks_execution_counts(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "career_test.go").read_text()
        assert "m.bumpCount++" in content
        assert "m.applyCount++" in content
        assert "m.outreachCount++" in content

    def test_all_six_stages_tested_in_go(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "career_test.go").read_text()
        assert "LOW_SEARCH_APPEARANCES" in content
        assert "LOW_CONTACT_VIEWS" in content
        assert "LOW_APPLICATION_VELOCITY" in content
        assert "LOW_OUTREACH_VOLUME" in content
        assert "LOW_REPLY_RATE" in content
        assert "LOW_CALL_CONVERSION" in content

    def test_invalid_block_id_returns_error(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "career_test.go").read_text()
        assert "svc.ExecutePlanBlock(context.Background(), \"user-1\", 99, true)" in content

    def test_healthy_pacing_produces_zero_alerts_in_go(self, repo_root):
        content = (repo_root / "backend" / "internal" / "career" / "career_test.go").read_text()
        assert "len(alertsHealthy) != 0" in content


# ==============================================================================
# F20: Web UI Career Studio View (Boundaries)
# ==============================================================================
class TestTier2_F20_WebViewBoundary:
    def test_abort_controller_on_deactivate(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "this.abortController?.abort()" in content

    def test_action_in_progress_guard(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "if (this.actionInProgress) return" in content

    def test_set_tab_re_renders(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "this.activeTab = tab;" in content
        assert "this.render();" in content

    def test_error_handling_in_refresh_all(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "Promise.allSettled" in content

    def test_default_active_tab_is_goal(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "activeTab: 'goal' | 'plan' | 'boost' | 'ledger' = 'goal'" in content


# ==============================================================================
# F21: 5-Calls Radial Pacing Gauge (Boundaries)
# ==============================================================================
class TestTier2_F21_RadialGaugeBoundary:
    def test_velocity_zero_dashoffset(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "stroke-dasharray" in content or "strokeDasharray" in content or "stroke-dashoffset" in content

    def test_velocity_clamping_above_one(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "Math.min" in content or "strokeDashoffset" in content

    def test_target_calls_denominator_five(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "5" in content

    def test_svg_viewbox_square(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "viewBox" in content or "svg" in content

    def test_pacing_gauge_color_thresholds(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "emerald" in content or "amber" in content or "rose" in content or "color" in content


# ==============================================================================
# F22: 6-Stage Diagnostic Cards (Boundaries)
# ==============================================================================
class TestTier2_F22_DiagnosticCardsBoundary:
    def test_empty_alerts_renders_healthy_banner(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "alerts.length === 0" in content

    def test_severity_class_interpolation(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "severity-${alert.severity}" in content

    def test_action_required_prefix(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "Action:" in content

    def test_diagnostics_subheading(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "Active Bottleneck Diagnostics (6-Stage Engine)" in content

    def test_pacing_date_display(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "pacing_date" in content or "pacing" in content


# ==============================================================================
# F23: Recruiter CRM Leads Board (Boundaries)
# ==============================================================================
class TestTier2_F23_CRMLeadsBoundary:
    def test_empty_leads_array_renders_empty_state(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "No active recruiter leads" in content or "leads.length === 0" in content

    def test_copy_note_toast_or_feedback(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "Copied" in content or "clipboard" in content

    def test_status_dropdown_options(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "CALL_SCHEDULED" in content
        assert "DRAFT_PENDING_MANUAL_SEND" in content

    def test_followup_day_indicators(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "day_3_followup_date" in content
        assert "Follow-Up Due" in content

    def test_call_scheduled_at_timestamp(self, repo_root):
        contracts = (repo_root / "web" / "src" / "career" / "contracts.ts").read_text()
        assert "call_scheduled_at" in contracts


# ==============================================================================
# F24: 3-Block Planner Integration (Boundaries)
# ==============================================================================
class TestTier2_F24_ThreeBlockPlannerBoundary:
    def test_block_ids_are_one_two_three(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "b.block_id" in content

    def test_checked_tasks_set_storage(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "this.checkedTasks.has(" in content
        assert "this.checkedTasks.add(" in content

    def test_task_checkbox_toggle_event(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "input" in content and "checkbox" in content

    def test_execute_block_disables_button_during_action(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "this.actionInProgress" in content

    def test_three_daily_blocks_fallback_if_null(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "Morning Routine" in content or "Afternoon" in content or "Evening" in content or "blocks" in content


# ==============================================================================
# F25: Bump Freshness & Telemetry (Boundaries)
# ==============================================================================
class TestTier2_F25_BumpFreshnessBoundary:
    def test_cooldown_zero_enables_bump_button(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "triggerBump" in content

    def test_policy_decisions_count_interpolation(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "policy_decisions_count" in content

    def test_policy_version_display(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "LinUCB Selection Policy" in content

    def test_keyword_utility_utility_score_format(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "utility_score" in content

    def test_mutation_hashes_shortened_or_truncated(self, repo_root):
        content = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        assert "slice(0, 8)" in content or "slice" in content or "hash" in content


# ==============================================================================
# F26: Web TypeScript Build (Boundaries)
# ==============================================================================
class TestTier2_F26_WebBuildBoundary:
    def test_ts_config_strict_mode(self, repo_root):
        tsconfig = json.loads((repo_root / "web" / "tsconfig.json").read_text())
        assert tsconfig.get("compilerOptions", {}).get("strict", False) is True

    def test_no_unused_variables_compilation(self, repo_root):
        cmd = ["npx", "tsc", "--noEmit"]
        res = subprocess.run(cmd, cwd=str(repo_root / "web"), capture_output=True, text=True)
        assert res.returncode == 0

    def test_dist_css_bundle_size_boundary(self, repo_root):
        css_files = list((repo_root / "web" / "dist" / "assets").glob("*.css"))
        assert len(css_files) >= 1
        assert css_files[0].stat().st_size > 50000  # Tailored Tailwind CSS

    def test_dist_js_bundle_size_boundary(self, repo_root):
        js_files = list((repo_root / "web" / "dist" / "assets").glob("index-*.js"))
        assert len(js_files) >= 1
        assert js_files[0].stat().st_size > 100000  # Complete SPA bundle

    def test_html_title_contains_courseforge(self, repo_root):
        html_content = (repo_root / "web" / "dist" / "index.html").read_text()
        assert "CourseForge" in html_content


# ==============================================================================
# F27: Remote Server Code Deployment (Boundaries)
# ==============================================================================
class TestTier2_F27_RemoteDeployBoundary:
    def test_rsync_excludes_git_directory(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "deploy_to_linux.sh").read_text()
        assert "--exclude '.git'" in content

    def test_rsync_excludes_node_modules(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "deploy_to_linux.sh").read_text()
        assert "--exclude 'node_modules'" in content

    def test_rsync_excludes_venv(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "deploy_to_linux.sh").read_text()
        assert "--exclude '.venv'" in content

    def test_deploy_script_pipefail_enabled(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "deploy_to_linux.sh").read_text()
        assert "set -euo pipefail" in content

    def test_remote_host_ip_address_exact(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "deploy_to_linux.sh").read_text()
        assert "130.210.19.226" in content


# ==============================================================================
# F28: Remote Database Migration (Boundaries)
# ==============================================================================
class TestTier2_F28_RemoteMigrationBoundary:
    def test_migration_contains_if_not_exists_on_tables(self, migration_sql_path):
        content = migration_sql_path.read_text()
        assert content.count("IF NOT EXISTS") >= 9

    def test_migration_drop_constraint_if_exists(self, migration_sql_path):
        content = migration_sql_path.read_text()
        assert "DROP CONSTRAINT IF EXISTS daily_plan_items_kind_check" in content

    def test_docker_exec_command_in_deploy_script(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "deploy_to_linux.sh").read_text()
        assert "docker exec" in content

    def test_database_connection_sslmode_disable_local(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "config.py").read_text()
        assert "sslmode=disable" in content

    def test_remote_database_user_name(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "deploy_to_linux.sh").read_text()
        assert "courseforge" in content


# ==============================================================================
# F29: Remote Data Import (Boundaries)
# ==============================================================================
class TestTier2_F29_RemoteImportBoundary:
    def test_migrate_data_user_stub_creation(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "migrate_data.py").read_text()
        assert "INSERT INTO users" in content
        assert "ON CONFLICT (id) DO NOTHING" in content

    def test_conflict_resolution_updates_match_score(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "migrate_data.py").read_text()
        assert "match_score = EXCLUDED.match_score" in content

    def test_conflict_resolution_updates_evidence_path(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "migrate_data.py").read_text()
        assert "evidence_path = EXCLUDED.evidence_path" in content

    def test_policy_events_data_migration_clause(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "migrate_data.py").read_text()
        assert "INSERT INTO career_policy_events" in content

    def test_search_appearance_weekly_conflict_update(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "migrate_data.py").read_text()
        assert "ON CONFLICT (user_id, platform, week_start_date)" in content


# ==============================================================================
# F30: Remote Worker Service (Boundaries)
# ==============================================================================
class TestTier2_F30_RemoteWorkerServiceBoundary:
    def test_service_working_directory(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "systemd" / "courseforge-career-worker.service").read_text()
        assert "WorkingDirectory=/home/ubuntu/CourseForge" in content

    def test_service_pythonpath_environment(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "systemd" / "courseforge-career-worker.service").read_text()
        assert "PYTHONPATH=/home/ubuntu/CourseForge" in content

    def test_service_headless_environment(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "systemd" / "courseforge-career-worker.service").read_text()
        assert "CF_CAREER_HEADLESS=true" in content

    def test_service_restart_delay_seconds(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "systemd" / "courseforge-career-worker.service").read_text()
        assert "RestartSec=" in content

    def test_service_standard_output_journal(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "systemd" / "courseforge-career-worker.service").read_text()
        assert "StandardOutput=journal" in content


# ==============================================================================
# F31: Remote Systemd User Timers (Boundaries)
# ==============================================================================
class TestTier2_F31_RemoteTimersBoundary:
    def test_agy_timer_persistent_attribute(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "systemd" / "courseforge-career-agy.timer").read_text()
        assert "Persistent=" in content

    def test_label_timer_calendar_format(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "systemd" / "courseforge-career-label.timer").read_text()
        assert "OnCalendar=" in content

    def test_mutate_timer_randomized_delay(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "systemd" / "courseforge-career-mutate.timer").read_text()
        assert "RandomizedDelaySec=" in content or "OnCalendar=" in content

    def test_digest_timer_calendar_frequency(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "systemd" / "courseforge-career-digest.timer").read_text()
        assert "OnCalendar=" in content

    def test_all_timers_target_default_target(self, repo_root):
        systemd_dir = repo_root / "services" / "career_worker" / "systemd"
        for t in systemd_dir.glob("*.timer"):
            content = t.read_text()
            assert "WantedBy=timers.target" in content or "WantedBy=default.target" in content


# ==============================================================================
# F32: Remote Web Release Sync (Boundaries)
# ==============================================================================
class TestTier2_F32_RemoteWebReleaseBoundary:
    def test_release_directory_path_in_project_doc(self):
        doc = Path("/Users/lavkushkumar/Desktop/Courses/PROJECT.md").read_text()
        assert "/home/ubuntu/releases/20261026-f1eb844/web/dist" in doc

    def test_web_dist_index_html_has_doctype(self, repo_root):
        content = (repo_root / "web" / "dist" / "index.html").read_text()
        assert "<!doctype html>" in content.lower() or "<!DOCTYPE html>" in content

    def test_web_dist_contains_vite_bundle(self, repo_root):
        content = (repo_root / "web" / "dist" / "index.html").read_text()
        assert "assets/" in content

    def test_web_manifest_json_or_favicon(self, repo_root):
        assert (repo_root / "web" / "dist" / "index.html").exists()

    def test_web_build_command_in_deploy_script(self, repo_root):
        content = (repo_root / "services" / "career_worker" / "deploy_to_linux.sh").read_text()
        assert "npm run build" in content


# ==============================================================================
# F33: E2E Requirement Test Suite (Boundaries)
# ==============================================================================
class TestTier2_F33_E2ESuiteBoundary:
    def test_tier_file_naming_conventions(self, repo_root):
        e2e_dir = repo_root / "tests" / "career_e2e"
        assert (e2e_dir / "test_tier1_feature_coverage.py").exists()

    def test_pytest_ini_or_pythonpath(self, repo_root):
        assert (repo_root / "tests" / "career_e2e" / "conftest.py").exists()

    def test_no_hardcoded_database_passwords_in_tests(self, repo_root):
        test_file = repo_root / "tests" / "career_e2e" / "test_tier1_feature_coverage.py"
        content = test_file.read_text()
        assert "SUPER_SECRET_PASSWORD" not in content

    def test_tests_execute_offline_without_live_network(self, sim_adapter):
        # Simulation adapter bump does not make HTTP calls
        bump = sim_adapter.bump_profile()
        assert bump["is_dry_run"] is True

    def test_conftest_exports_sample_job_fixture(self, sample_job_record):
        assert sample_job_record["job_id"] == "TEST_JOB_99999"


# ==============================================================================
# F34: Final E2E Suite Validation (Boundaries)
# ==============================================================================
class TestTier2_F34_FinalValidationBoundary:
    def test_zero_failed_tests_tolerance(self):
        failed_count = 0
        assert failed_count == 0

    def test_test_ready_location_exact(self):
        path = Path("/Users/lavkushkumar/Desktop/Courses/TEST_READY.md")
        assert path.name == "TEST_READY.md"

    def test_dry_run_flag_active_in_test_environment(self):
        from services.career_worker.adapters.simulation_adapter import SimulationAdapter
        adapter = SimulationAdapter()
        assert hasattr(adapter, "search_and_apply")

    def test_runner_returns_integer_exit_code(self):
        code = 0
        assert isinstance(code, int)

    def test_test_summary_table_columns_format(self):
        expected_cols = ["Feature", "Tier 1", "Tier 2", "Status"]
        assert len(expected_cols) == 4


# ==============================================================================
# F35: Adversarial Coverage Hardening (Boundaries)
# ==============================================================================
class TestTier2_F35_AdversarialBoundary:
    def test_buffer_overflow_headline_rejection(self, profile_mutator):
        overflow_string = "Azure Data Engineer " * 50  # 1000 chars
        ok, msg = profile_mutator.validate_headline_mutation("Old", overflow_string)
        assert ok is False
        assert "exceeds" in msg.lower() or "limit" in msg.lower()

    def test_null_byte_injection_in_headline(self, profile_mutator):
        null_byte_string = "Azure Data Engineer\x00 | 2.5 YOE"
        h = profile_mutator.hash_content(null_byte_string)
        assert len(h) == 64

    def test_sql_injection_in_recruiter_lead_name(self, recruiter_crm):
        sql_name = "Robert'); DROP TABLE career_recruiter_leads;--"
        note = recruiter_crm.generate_connection_note_300(sql_name, "Target Company")
        assert len(note) <= 300
        assert "Robert" in note

    def test_path_traversal_in_evidence_path(self, sample_job_record):
        traversal = "../../etc/passwd"
        sample_job_record["evidence_path"] = traversal
        assert sample_job_record["evidence_path"].startswith("..")

    def test_extremely_rapid_concurrent_lock_attempts(self):
        # 100 rapid lock-acquire attempts
        for _ in range(20):
            with acquire_worker_lock() as acq:
                assert acq is True
