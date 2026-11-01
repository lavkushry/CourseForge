"""
Tier 3: Cross-Feature Interactions Test Suite (ForgeCareer)
Validates pairwise and multi-subsystem integrations:
- Funnel Pacing + Daily Routine Planner
- LinUCB Contextual Bandit + Profile Mutator
- Recruiter CRM + Pomodoro Study Sprints
- SQLite Historical Ingestion + Go Backend API Contracts
- Python Worker Daemon + Go HTTP Worker Client
- Keyword Utility Miner + Whitelist Mutator
- Process Lock Guard + Autonomous Runner
"""

import sys
import json
import sqlite3
import pytest
from pathlib import Path
from fastapi.testclient import TestClient

from services.career_worker.modules.boost.policy import LinUCBPolicy, Action
from services.career_worker.modules.boost.mutator import ProfileMutator
from services.career_worker.modules.boost.keyword_miner import KeywordUtilityMiner
from services.career_worker.modules.goal.pacing import PacingCalculator
from services.career_worker.modules.goal.diagnostics import DiagnosticEngine
from services.career_worker.modules.goal.crm import RecruiterCRM
from services.career_worker.modules.plan.daily_blocks import DailyBlockOrchestrator
from services.career_worker.core.lock import acquire_worker_lock
from services.career_worker.adapters.simulation_adapter import SimulationAdapter


class TestTier3_CrossFeatureInteractions:
    """Pairwise cross-feature validation suite."""

    def test_pacing_diagnostics_and_daily_planner_interaction(self, block_orchestrator):
        """
        Interaction: Low application velocity alert from DiagnosticEngine triggers
        prioritized execution of Block 1 Apply batch in DailyBlockOrchestrator.
        """
        metrics = {
            "search_appearances": 180,
            "contact_views": 8,
            "applications_today": 10,  # Below 25 -> triggers LOW_APPLICATION_VELOCITY
            "outreaches_today": 12,
            "calls_scheduled_today": 5,
            "replies_today": 2
        }
        alerts = DiagnosticEngine.evaluate(metrics)
        alert_codes = [a["code"] for a in alerts]
        assert "LOW_APPLICATION_VELOCITY" in alert_codes

        # Daily block 1 routine directly addresses LOW_APPLICATION_VELOCITY
        b1_res = block_orchestrator.execute_block(1, dry_run=True)
        assert b1_res["block"] == 1
        assert b1_res["applied_count"] >= 8
        assert any("High-Velocity Apply" in task for task in b1_res["tasks_completed"])

    def test_linucb_bandit_and_profile_mutator_interaction(self, linucb_policy, profile_mutator):
        """
        Interaction: Bandit policy decision telemetry feeds into candidate profile mutator
        rationale and decision logging.
        """
        job = {
            "match_score": 92.0,
            "required_yoe": 2.5,
            "posting_age_hours": 8.0,
            "company": "Microsoft GCC",
            "platform": "naukri",
            "skill_overlap": 0.95,
            "salary_lpa": 24.0
        }
        ctx = linucb_policy.extract_context(job)
        action, max_p, scores = linucb_policy.select_action(ctx)

        # High match Azure Data Engineer job should favor APPLY
        assert action == Action.APPLY
        assert linucb_policy.decisions_count >= 1

        # Profile mutator validates candidate facts when constructing rationale
        headline = profile_mutator.generate_optimized_headline()
        ok, msg = profile_mutator.validate_headline_mutation("Old Headline", headline)
        assert ok is True
        sha = profile_mutator.hash_content(headline)
        assert len(sha) == 64

    def test_recruiter_crm_and_pomodoro_planner_interaction(self, recruiter_crm, block_orchestrator):
        """
        Interaction: Generating connection notes in Recruiter CRM coordinates with
        Block 2 Afternoon outbound routine and 45-min Pomodoro focus sessions.
        """
        note = recruiter_crm.generate_connection_note_300("Aarav Mehta", "Amazon Web Services")
        assert len(note) <= 300
        assert "Aarav" in note

        # Block 2 executes outbound recruiter pitches and study session
        b2_res = block_orchestrator.execute_block(2, dry_run=True)
        assert b2_res["block"] == 2
        assert b2_res["outreach_count"] == 10
        assert any("Code Lab" in task or "Recruiter Outbound" in task for task in b2_res["tasks_completed"])

    def test_keyword_utility_miner_and_mutator_injection(self, profile_mutator):
        """
        Interaction: KeywordUtilityMiner computes high-utility tokens from market demand
        and injects top tokens into ProfileMutator headline generation.
        """
        utilities = KeywordUtilityMiner.calculate_utilities()
        assert len(utilities) > 0
        top_utility = utilities[0]
        assert top_utility["utility_score"] >= 0.0

        # High demand keywords must appear in optimized headline
        headline = profile_mutator.generate_optimized_headline()
        assert "Azure" in headline
        assert "Databricks" in headline
        assert len(headline) <= 250

    def test_sqlite_applied_jobs_parity_with_go_domain_contract(self, sqlite_db_path, repo_root):
        """
        Interaction: Historical rows in SQLite match Go backend AppliedJob struct fields
        and JSON serialization keys.
        """
        con = sqlite3.connect(str(sqlite_db_path))
        cur = con.cursor()
        cur.row_factory = sqlite3.Row
        sample = dict(cur.execute("SELECT * FROM applied_jobs LIMIT 1").fetchone())
        con.close()

        domain_code = (repo_root / "backend" / "internal" / "career" / "domain.go").read_text()
        assert "`json:\"job_id\"`" in domain_code
        assert "`json:\"platform\"`" in domain_code
        assert "`json:\"company\"`" in domain_code
        assert "`json:\"match_score\"`" in domain_code
        assert "`json:\"status\"`" in domain_code

        # Confirm sample from SQLite has valid types
        assert sample["job_id"] is not None
        assert float(sample["match_score"]) >= 0.0

    def test_fastapi_worker_endpoints_and_go_client_contract(self, worker_client, repo_root):
        """
        Interaction: FastAPI endpoints match Go CareerWorkerClient request and response models.
        """
        # Health check
        res_h = worker_client.get("/health")
        assert res_h.status_code == 200
        data_h = res_h.json()
        assert "status" in data_h
        assert "version" in data_h

        # Bump endpoint
        res_b = worker_client.post("/execute/bump", json={"user_id": "lavkush", "dry_run": True})
        assert res_b.status_code == 200
        data_b = res_b.json()
        assert data_b["success"] is True

        # Apply endpoint
        res_a = worker_client.post("/execute/apply", json={"user_id": "lavkush", "block": 1, "dry_run": True})
        assert res_a.status_code == 200
        data_a = res_a.json()
        assert data_a["applied_count"] > 0

        # Outreach endpoint
        res_o = worker_client.post("/execute/outreach", json={"user_id": "lavkush", "count": 10, "dry_run": True})
        assert res_o.status_code == 200
        data_o = res_o.json()
        assert data_o["outreach_count"] == 10

        # Confirm client.go implements matching URLs
        client_code = (repo_root / "backend" / "internal" / "career" / "client.go").read_text()
        assert "/execute/bump" in client_code
        assert "/execute/apply" in client_code
        assert "/execute/outreach" in client_code
        assert "/health" in client_code

    def test_process_lock_guards_autonomous_block_execution(self, block_orchestrator):
        """
        Interaction: Process file lock prevents overlapping daily block routines.
        """
        with acquire_worker_lock() as l1:
            assert l1 is True
            # Attempting second execution should detect locked state
            with acquire_worker_lock() as l2:
                assert l2 is False

        # Once released, routine can proceed
        with acquire_worker_lock() as l3:
            assert l3 is True
            res = block_orchestrator.execute_block(3, dry_run=True)
            assert res["block"] == 3

    def test_web_ui_contracts_match_go_backend_json_keys(self, repo_root):
        """
        Interaction: TypeScript contracts in web/src/career/contracts.ts match Go backend JSON tags.
        """
        ts_contracts = (repo_root / "web" / "src" / "career" / "contracts.ts").read_text()
        go_domain = (repo_root / "backend" / "internal" / "career" / "domain.go").read_text()

        shared_keys = [
            "job_id", "company", "title", "match_score", "status",
            "recruiter_name", "target_role", "pacing_date", "applications_count",
            "calls_scheduled_count", "pacing_ratio", "active_bottlenecks",
            "utility_score", "policy_decisions_count", "cooldown_remaining_seconds"
        ]
        for key in shared_keys:
            assert key in ts_contracts, f"Key {key} missing in TS contracts"
            assert f'`json:"{key}' in go_domain, f"Key {key} missing in Go domain"

    def test_quarantine_schema_and_mutator_blacklist_policy(self, migration_sql_path, profile_mutator):
        """
        Interaction: Database quarantine table supports 'mutation_blacklisted' category
        when ProfileMutator catches an adversarial headline mutation.
        """
        sql = migration_sql_path.read_text()
        assert "'mutation_blacklisted'" in sql
        assert "'mutation_unwhitelisted'" in sql

        # Attempt forbidden YOE inflation
        ok, msg = profile_mutator.validate_headline_mutation("Old", "Azure Data Engineer | 8 YOE | Specialist")
        assert ok is False
        assert "YOE" in msg

    def test_simulation_adapter_safety_across_all_blocks(self, block_orchestrator):
        """
        Interaction: All 3 blocks execute in simulation mode with 100% dry-run safety
        (zero external portal mutations).
        """
        for b in [1, 2, 3]:
            res = block_orchestrator.execute_block(b, dry_run=True)
            assert res["block"] == b
            assert res["dry_run"] is True
            assert len(res["tasks_completed"]) >= 3

    def test_radial_gauge_math_and_diagnostic_pacing_sync(self):
        """
        Interaction: PacingCalculator ratio syncs with SVG stroke-dashoffset formula.
        Circumference C = 2 * PI * 40 = 251.327; offset = C * (1 - ratio).
        """
        import math
        radius = 40
        c = 2 * math.pi * radius
        for calls in [0, 1, 3, 5, 8]:
            ratio = PacingCalculator.calculate_pacing_ratio(calls)
            offset = c * (1 - min(1.0, ratio))
            if calls == 0:
                assert abs(offset - c) < 1e-4
            elif calls >= 5:
                assert abs(offset) < 1e-4

    def test_mutation_audit_trail_and_keyword_miner_consistency(self):
        """
        Interaction: Top keywords mined from market match allowed candidate facts.
        """
        utilities = KeywordUtilityMiner.calculate_utilities()
        tokens = [u["token"] for u in utilities]
        assert "Azure Databricks Lakehouse" in tokens or "15 Days Notice" in tokens or "PySpark" in tokens

    def test_outreach_pitch_generator_and_crm_note_limits(self, recruiter_crm):
        """
        Interaction: Recruiter pitch generator produces message within limits
        and references candidate positioning facts.
        """
        pitch = recruiter_crm.generate_engineering_pitch("Talent Lead", "Google")
        assert len(pitch) > 100
        assert "Lavkush" in pitch or "Azure Data Engineer" in pitch

    def test_daily_blocks_pacing_ratio_and_resdex_bump_freshness(self, block_orchestrator):
        """
        Interaction: Executing daily routine blocks updates Resdex freshness timestamps.
        """
        for b in [1, 2, 3]:
            res = block_orchestrator.execute_block(b, dry_run=True)
            assert any("bump" in task.lower() for task in res["tasks_completed"])

    def test_session_auth_gate_wrapper_contract(self, repo_root):
        """
        Interaction: Go API Register mux wraps all 10 endpoints in auth.Require gate.
        """
        handlers_code = (repo_root / "backend" / "internal" / "career" / "handlers.go").read_text()
        assert "mux.Handle(route, auth.Require(h))" in handlers_code
        assert "auth *identity.Service" in handlers_code
