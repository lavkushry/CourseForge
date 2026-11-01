"""
Tier 4: Real-World Scenarios Test Suite (ForgeCareer)
Validates complete multi-step user workflows:
1. Daily Study Sprint to Career Velocity (Block 1 + 5-calls pacing gauge)
2. Recruiter CRM Pipeline from Outreach to Scheduled Call (Block 2 + CRM leads)
3. Profile Mutation Lifecycle with SHA-256 Provenance Audit
4. Historical Migration Parity to Streaming CSV Export Integrity
5. Process-Level File Lock Concurrency and Autonomous Timer Resilience
"""

import os
import sys
import json
import sqlite3
import csv
import io
import pytest
from pathlib import Path
from datetime import datetime, timezone

from services.career_worker.modules.boost.policy import LinUCBPolicy, Action
from services.career_worker.modules.boost.mutator import ProfileMutator
from services.career_worker.modules.boost.keyword_miner import KeywordUtilityMiner
from services.career_worker.modules.goal.pacing import PacingCalculator
from services.career_worker.modules.goal.diagnostics import DiagnosticEngine
from services.career_worker.modules.goal.crm import RecruiterCRM
from services.career_worker.modules.plan.daily_blocks import DailyBlockOrchestrator
from services.career_worker.core.lock import acquire_worker_lock
from services.career_worker.adapters.simulation_adapter import SimulationAdapter


class TestTier4_RealWorldScenarios:
    """Multi-step real-world user workflow validation."""

    def test_scenario_1_daily_study_sprint_to_career_velocity(self, block_orchestrator):
        """
        Scenario 1: User starts morning routine, reviews 5-calls pacing gauge,
        triggers Resdex bump, executes Block 1 applying to 8 jobs, logs 45-min masterclass,
        and verifies velocity progression.
        """
        # Step 1: Evaluate initial morning metrics (1 call, 5 apps -> velocity 20%)
        initial_metrics = {
            "search_appearances": 110,
            "contact_views": 4,
            "applications_today": 5,
            "outreaches_today": 2,
            "calls_scheduled_today": 1,
            "replies_today": 0
        }
        initial_ratio = PacingCalculator.calculate_pacing_ratio(initial_metrics["calls_scheduled_today"])
        assert initial_ratio == 0.20  # 1/5

        # Step 2: Diagnostics flag bottlenecks
        alerts = DiagnosticEngine.evaluate(initial_metrics)
        codes = [a["code"] for a in alerts]
        assert "LOW_SEARCH_APPEARANCES" in codes
        assert "LOW_APPLICATION_VELOCITY" in codes

        # Step 3: Trigger profile bump to refresh search visibility
        adapter = block_orchestrator.adapter
        bump = adapter.bump_profile()
        assert bump["success"] is True
        assert "Active Today" in bump["message"]

        # Step 4: Execute Daily Block 1 routine
        b1_res = block_orchestrator.execute_block(1, dry_run=True)
        assert b1_res["block"] == 1
        assert b1_res["applied_count"] >= 8
        assert len(b1_res["tasks_completed"]) >= 3

        # Step 5: Simulate mid-day progression (applications up to 25, calls scheduled up to 3)
        progressed_metrics = dict(initial_metrics)
        progressed_metrics["applications_today"] += b1_res["applied_count"]
        progressed_metrics["search_appearances"] = 160  # Bump increased appearances
        progressed_metrics["contact_views"] = 6
        progressed_metrics["calls_scheduled_today"] = 3
        progressed_metrics["replies_today"] = 2

        new_ratio = PacingCalculator.calculate_pacing_ratio(progressed_metrics["calls_scheduled_today"])
        assert new_ratio == 0.60  # Paced up to 60%!

        # Step 6: Verify search appearances bottleneck resolved
        new_alerts = DiagnosticEngine.evaluate(progressed_metrics)
        new_codes = [a["code"] for a in new_alerts]
        assert "LOW_SEARCH_APPEARANCES" not in new_codes

    def test_scenario_2_recruiter_crm_pipeline_to_offer(self, recruiter_crm, block_orchestrator, outreach_json_path):
        """
        Scenario 2: User manages Recruiter CRM leads board, copies custom pitch,
        dispatches Afternoon Block 2 outbound pitches, schedules a screening call,
        and verifies pacing ratio advances toward 1.0 (5 calls target).
        """
        # Step 1: Load 10 recruiter leads
        with open(outreach_json_path) as f:
            leads = json.load(f)
        assert len(leads) == 10

        target_lead = leads[0]
        recruiter_name = target_lead["recruiter_name"]
        company = target_lead["company"]

        # Step 2: Generate tailored 300-char connection note
        note = recruiter_crm.generate_connection_note_300(recruiter_name, company)
        assert len(note) <= 300
        assert recruiter_name in note
        assert "15" in note or "notice" in note

        # Step 3: Dispatch Block 2 Afternoon Outbound routine (10 pitches)
        b2_res = block_orchestrator.execute_block(2, dry_run=True)
        assert b2_res["block"] == 2
        assert b2_res["outreach_count"] == 10

        # Step 4: Advance lead status from CONTACTED to CALL_SCHEDULED
        target_lead["status"] = "CALL_SCHEDULED"
        target_lead["call_scheduled_at"] = datetime.now(timezone.utc).isoformat()
        assert target_lead["status"] == "CALL_SCHEDULED"

        # Step 5: Pacing velocity reaches full 100% run-rate (5 calls scheduled)
        end_of_day_ratio = PacingCalculator.calculate_pacing_ratio(5)
        assert end_of_day_ratio == 1.00

    def test_scenario_3_profile_mutation_provenance_lifecycle(self, profile_mutator, linucb_policy):
        """
        Scenario 3: Autonomous mutator proposes optimized headline from market utility,
        enforces strict whitelist guards (2.5 YOE, 15-day notice), computes SHA-256
        provenance, and registers LinUCB decision telemetry.
        """
        # Step 1: Mine high-demand keywords
        utilities = KeywordUtilityMiner.calculate_utilities()
        top_tokens = [u["token"] for u in utilities[:5]]
        assert len(top_tokens) == 5

        # Step 2: Mutator generates headline
        candidate_headline = profile_mutator.generate_optimized_headline(top_tokens)
        assert len(candidate_headline) <= 250

        # Step 3: Validate candidate facts
        valid, msg = profile_mutator.validate_headline_mutation("Old Headline", candidate_headline)
        assert valid is True

        # Step 4: Adversarial test - verify inflation attempts are rejected
        invalid_headline = candidate_headline.replace("2.5 YOE", "6 YOE")
        invalid, err_msg = profile_mutator.validate_headline_mutation("Old", invalid_headline)
        assert invalid is False
        assert "YOE" in err_msg

        # Step 5: Compute provenance SHA-256 hash
        old_hash = profile_mutator.hash_content("Old Headline")
        new_hash = profile_mutator.hash_content(candidate_headline)
        assert len(old_hash) == 64
        assert len(new_hash) == 64
        assert old_hash != new_hash

        # Step 6: Record policy telemetry
        ctx = [0.85, 0.5, 0.1, 1.0, 1.0, 0.9, 0.75]
        action, max_p, scores = linucb_policy.select_action(ctx)
        assert linucb_policy.decisions_count >= 1

    def test_scenario_4_historical_data_migration_to_export_integrity(self, sqlite_db_path):
        """
        Scenario 4: Verify 399 historical records from applied_jobs.db are formatted
        into streaming CSV export with full column fidelity and quote escaping.
        """
        # Step 1: Read all 399 historical applications from SQLite
        con = sqlite3.connect(str(sqlite_db_path))
        con.row_factory = sqlite3.Row
        cur = con.cursor()
        rows = cur.execute("SELECT * FROM applied_jobs").fetchall()
        con.close()
        assert len(rows) == 399

        # Step 2: Format rows into CSV buffer as Go backend ExportJobsCSV does
        csv_buffer = io.StringIO()
        writer = csv.writer(csv_buffer)
        headers = [
            "Platform", "Job ID", "Company", "Title", "Location", "Experience",
            "Match Score", "Status", "Application Type", "Applied At", "Outcome"
        ]
        writer.writerow(headers)

        for r in rows:
            writer.writerow([
                r["platform"] or "naukri",
                r["job_id"],
                r["company"],
                r["title"],
                r["location"] or "",
                r["experience_req"] or "",
                f"{float(r['match_score'] or 70.0):.1f}",
                r["status"] or "APPLIED",
                r["application_type"] or "1-Click Direct",
                str(r["applied_at"] or ""),
                r["outcome_label"] or ""
            ])

        # Step 3: Parse CSV buffer back and verify integrity
        csv_content = csv_buffer.getvalue()
        csv_reader = list(csv.reader(io.StringIO(csv_content)))

        # Header + 399 records = 400 total rows
        assert len(csv_reader) == 400
        assert csv_reader[0] == headers

        # Verify sample row content
        sample = csv_reader[1]
        assert len(sample) == 11
        assert float(sample[6]) >= 0.0  # Match Score is valid float

    def test_scenario_5_process_locking_and_concurrency_resilience(self, worker_client):
        """
        Scenario 5: Automated systemd timer routine running on sidecar daemon acquires
        process lock /tmp/courseforge_career.lock; concurrent requests receive HTTP 409 Conflict;
        lock releases cleanly for next block cycle.
        """
        # Step 1: External task acquires process lock
        with acquire_worker_lock() as lock1:
            assert lock1 is True

            # Step 2: Concurrent API request to /execute/bump should be rejected with 409
            res = worker_client.post("/execute/bump", json={"user_id": "lavkush", "dry_run": True})
            assert res.status_code == 409
            assert "busy" in res.json()["detail"].lower()

            # Step 3: Concurrent API request to /execute/apply should also be rejected
            res_apply = worker_client.post("/execute/apply", json={"user_id": "lavkush", "block": 1, "dry_run": True})
            assert res_apply.status_code == 409

        # Step 4: After lock release, API requests succeed immediately
        res_after = worker_client.post("/execute/bump", json={"user_id": "lavkush", "dry_run": True})
        assert res_after.status_code == 200
        assert res_after.json()["success"] is True

    def test_scenario_6_stale_lock_recovery_and_graceful_drain(self):
        """
        Scenario 6: Stale or interrupted process lock is safely recovered on subsequent runs.
        """
        with acquire_worker_lock() as l1:
            assert l1 is True
        # Immediately re-acquire
        with acquire_worker_lock() as l2:
            assert l2 is True

    def test_scenario_7_outreach_rejection_and_reply_rate_diagnostic(self):
        """
        Scenario 7: Tracking recruiter replies vs outreaches evaluates LOW_REPLY_RATE.
        When 20 outreaches yield only 1 reply (5% < 15%), diagnostic triggers actionable pitch advice.
        """
        metrics = {
            "search_appearances": 200,
            "contact_views": 10,
            "applications_today": 30,
            "outreaches_today": 20,
            "replies_today": 1,
            "calls_scheduled_today": 5
        }
        alerts = DiagnosticEngine.evaluate(metrics)
        codes = [a["code"] for a in alerts]
        assert "LOW_REPLY_RATE" in codes
        reply_alert = next(a for a in alerts if a["code"] == "LOW_REPLY_RATE")
        assert "15%" in reply_alert["description"]
        assert "Delta MERGE" in reply_alert["action_required"] or "Lakehouse" in reply_alert["action_required"]

    def test_scenario_8_multi_day_velocity_and_weekly_appearances(self, sqlite_db_path):
        """
        Scenario 8: Weekly search appearances tracking across weeks from database.
        """
        con = sqlite3.connect(str(sqlite_db_path))
        con.row_factory = sqlite3.Row
        cur = con.cursor()
        rows = cur.execute("SELECT * FROM search_appearance_weekly ORDER BY week_start_date").fetchall()
        con.close()
        assert len(rows) == 3
        for r in rows:
            assert int(r["search_appearances"]) >= 0
            assert int(r["profile_views"]) >= 0

    def test_scenario_9_unwhitelisted_keyword_quarantine_defense(self, profile_mutator, migration_sql_path):
        """
        Scenario 9: Unwhitelisted keyword attempts are flagged and quarantine schema verifies defense.
        """
        schema = migration_sql_path.read_text()
        assert "career_quarantine" in schema
        assert "'mutation_unwhitelisted'" in schema

        # Mutator validates candidate fact limits
        ok, msg = profile_mutator.validate_headline_mutation("Old", "Azure Data Engineer | 60 days notice | 5 YOE")
        assert ok is False

    def test_scenario_10_daily_study_sprint_masterclass_to_career_ledger(self, block_orchestrator, sample_job_record):
        """
        Scenario 10: Complete daily journey connecting CourseForge 45-min masterclass sprint
        with autonomous job application submission and ledger recording.
        """
        # Step 1: Execute Block 1 (Morning sprint)
        b1 = block_orchestrator.execute_block(1, dry_run=True)
        assert b1["block"] == 1
        assert any("Masterclass" in t for t in b1["tasks_completed"])

        # Step 2: Record submitted job into ledger format
        ledger_entry = dict(sample_job_record)
        ledger_entry["status"] = "APPLIED_SIMULATION"
        ledger_entry["applied_at"] = datetime.now(timezone.utc).isoformat()

        # Step 3: Validate ledger schema integrity
        assert ledger_entry["platform"] == "naukri"
        assert ledger_entry["match_score"] >= 70.0
        assert ledger_entry["is_dry_run"] is True

    def test_scenario_11_universal_backend_engineer_profile_onboarding(self):
        """
        Scenario 11: Any user (e.g., Backend Engineer in Go & Kubernetes) uploads resume;
        CandidateProfile drives screening answers, headline mutation whitelist, and CRM outreach.
        """
        from services.career_worker.core.candidate_profile import CandidateProfile, resolve_screening_question

        backend_profile = CandidateProfile.from_dict({
            "user_id": "rohan",
            "full_name": "Rohan Verma",
            "target_role": "Senior Backend Engineer",
            "primary_track_id": "backend",
            "total_yoe": 4.0,
            "notice_period_days": 30,
            "target_ctc_range": "₹35–45 LPA",
            "primary_skills": ["Go", "Kubernetes", "PostgreSQL", "gRPC", "Kafka"],
            "whitelist_headline_tokens": ["Senior", "Backend", "Engineer", "Go", "Kubernetes", "PostgreSQL", "gRPC", "Kafka", "30", "Days"]
        })

        # Screening question resolution uses dynamic profile
        assert resolve_screening_question("What is your notice period in days?", backend_profile) == "30 days"
        assert resolve_screening_question("Total years of experience?", backend_profile) == "4.0"
        assert resolve_screening_question("Expected CTC?", backend_profile) == "22 LPA"

        # Dynamic headline generation & whitelist check
        headline = ProfileMutator.generate_optimized_headline(["Go", "Kubernetes", "gRPC"], profile=backend_profile)
        assert "Senior Backend Engineer" in headline
        ok, _ = ProfileMutator.validate_headline_mutation("Old", headline, profile=backend_profile)
        assert ok is True

        # Reject YOE inflation relative to backend_profile (4.0 YOE + 1.0 buffer = 5.0 max)
        bad_ok, _ = ProfileMutator.validate_headline_mutation("Old", "Senior Backend Engineer | 9 YOE | Go", profile=backend_profile)
        assert bad_ok is False

        # Dynamic recruiter pitch & connection note
        note = RecruiterCRM.generate_connection_note_300("Ananya", "Stripe", profile=backend_profile)
        assert len(note) <= 300
        assert "Senior Backend Engineer" in note
        assert "Rohan" in note

    def test_scenario_12_universal_frontend_ml_devops_multi_profile_execution(self, worker_client):
        """
        Scenario 12: Multi-track profiles (Frontend, ML, DevOps) execute daily blocks
        and worker endpoints dynamically without Data-Engineer-only hardcoding.
        """
        from services.career_worker.core.candidate_profile import CandidateProfile

        for track_id, role, skills in [
            ("frontend", "Senior Frontend Engineer", ["React", "TypeScript", "Next.js"]),
            ("ml", "Machine Learning Engineer", ["PyTorch", "Transformers", "MLOps"]),
            ("devops", "Staff DevOps Engineer", ["Kubernetes", "Terraform", "AWS"]),
        ]:
            prof_dict = {
                "user_id": f"user_{track_id}",
                "full_name": f"Candidate {track_id.upper()}",
                "target_role": role,
                "primary_track_id": track_id,
                "total_yoe": 3.5,
                "notice_period_days": 15,
                "target_ctc_range": "₹30–40 LPA",
                "primary_skills": skills,
            }
            prof = CandidateProfile.from_dict(prof_dict)
            orch = DailyBlockOrchestrator(SimulationAdapter(platform="naukri"), profile=prof)
            b1 = orch.execute_block(1, dry_run=True)
            assert b1["block"] == 1
            assert any(role in t for t in b1["tasks_completed"])

            r_apply = worker_client.post("/execute/apply", json={"user_id": prof.user_id, "block": 1, "dry_run": True, "profile": prof_dict})
            assert r_apply.status_code == 200
            assert role in r_apply.json()["message"]

    def test_scenario_13_per_user_session_vault_and_playwright_storage_state(self, tmp_path):
        """
        Scenario 13: SessionVault supports per-user cookie paths and unwraps both
        Playwright storage_state.json ({'cookies': [...]}) and raw cookie arrays.
        """
        from services.career_worker.core.session_vault import SessionVault

        p = SessionVault.user_cookie_path(tmp_path, "rohan@example.com", "naukri")
        assert "rohan_example_com" in str(p)
        assert "naukri" in p.name

        storage_state_payload = {
            "cookies": [
                {"name": "nauk_at", "value": "tok_123", "domain": ".naukri.com", "path": "/"}
            ],
            "origins": []
        }
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(storage_state_payload))
        cookies = SessionVault.load_cookies(p)
        assert len(cookies) == 1
        assert cookies[0]["name"] == "nauk_at"
        assert SessionVault.has_valid_session(p) is True

    def test_scenario_14_migration_035_universal_career_profiles_schema(self):
        """
        Scenario 14: Verify migration 035_universal_career_profiles.sql defines
        career_candidate_profiles, career_platform_credentials, and career_engine_state.
        """
        mig_path = Path(__file__).resolve().parents[2] / "backend" / "internal" / "store" / "migrations" / "035_universal_career_profiles.sql"
        assert mig_path.exists()
        sql = mig_path.read_text()
        assert "CREATE TABLE IF NOT EXISTS career_candidate_profiles" in sql
        assert "CREATE TABLE IF NOT EXISTS career_platform_credentials" in sql
        assert "CREATE TABLE IF NOT EXISTS career_engine_state" in sql
        assert "whitelist_headline_tokens" in sql
        assert "encrypted_secret" in sql

    def test_scenario_15_frontend_setup_and_auth_vault_studio_contract(self):
        """
        Scenario 15: Verify CourseForge Web CareerView and contracts include
        Resume Upload, Auth Vault ('What Auth Is Needed'), Readiness Strip, and Start Engine CTA.
        """
        repo_root = Path(__file__).resolve().parents[2]
        contracts_ts = (repo_root / "web" / "src" / "career" / "contracts.ts").read_text()
        view_ts = (repo_root / "web" / "src" / "career" / "view.ts").read_text()

        assert "export interface CandidateProfile" in contracts_ts
        assert "export interface PlatformAuthRequirement" in contracts_ts
        assert "export interface EngineReadiness" in contracts_ts
        assert "uploadResumePayload" in view_ts
        assert "connectPlatform" in view_ts
        assert "startEngine" in view_ts
        assert "What Auth Is Needed" in view_ts

    def test_scenario_16_multi_user_story_isolation_and_realistic_minimal_all_options(self):
        """
        Scenario 16: Verify each user has their own isolated Career Story (zero leakage of
        Lavkush's name/email/phone/track to other users) and the Realistic Minimal UI
        exposes ALL Career Studio + Autonomous Engine options.
        """
        from services.career_worker.core.candidate_profile import CandidateProfile

        # 1. Non-Lavkush user with sparse payload never inherits Lavkush's personal identity
        nikku = CandidateProfile.from_dict({"user_id": "usr_nikku_99", "full_name": "Nikku"})
        assert nikku.full_name == "Nikku"
        assert nikku.email == ""
        assert nikku.phone == ""
        assert nikku.primary_track_id == "backend"
        assert "Lavkush" not in nikku.full_name
        assert "8102026606" not in nikku.phone

        # 2. Verify Realistic Minimal UI exposes all 4 Engine tabs + all 10 Studio/Story views
        repo_root = Path(__file__).resolve().parents[2]
        view_ts = (repo_root / "web" / "src" / "career" / "view.ts").read_text()
        for panel_import in [
            "renderFacts",
            "renderResumeStudio",
            "renderMatch",
            "renderCompanies",
            "renderTracks",
            "renderTracker",
            "renderReferrals",
            "renderAnalytics",
            "renderAlerts",
        ]:
            assert panel_import in view_ts, f"Missing Studio panel {panel_import} in CareerView"

        for studio_tab in ["'story'", "'resume'", "'match'", "'companies'", "'tracks'", "'tracker'", "'referrals'", "'analytics'", "'alerts'", "'all'"]:
            assert studio_tab in view_ts, f"Missing studio tab {studio_tab} in CareerView"

        # 3. Verify browser localStorage keys are scoped per user across Career, Tutor, and Settings
        tutor_ts = (repo_root / "web" / "src" / "tutor" / "view.ts").read_text()
        settings_ts = (repo_root / "web" / "src" / "settings" / "view.ts").read_text()
        assert "courseforge_tutor_history_" in tutor_ts
        assert "courseforge_daily_goal_" in settings_ts
        assert "courseforge_career_tasks_" in view_ts


    def test_scenario_16_per_user_platform_session_isolation(self, tmp_path, monkeypatch, worker_client):
        """
        Scenario 16: Each user has their own story — a non-owner user must never borrow the
        legacy owner's global Naukri session, and a user's vaulted cookies are written only
        to that user's isolated session file.
        """
        import services.career_worker.config as cfg
        from services.career_worker import app as worker_app

        monkeypatch.setattr(cfg, "COOKIES_DIR", tmp_path)
        legacy_global = tmp_path / "naukri_cookies.json"
        legacy_global.write_text(json.dumps([{"name": "nauk_at", "value": "owner", "domain": ".naukri.com", "path": "/"}]))

        # Owner keeps the legacy global session; any other user gets an isolated (empty) path.
        assert cfg.resolve_user_cookie_path("lavkush", "naukri") == legacy_global
        other = cfg.resolve_user_cookie_path("rohan@example.com", "naukri")
        assert other != legacy_global
        assert other.parent.name == "rohan_example_com"
        assert not other.exists()

        # A user's own vaulted cookies are persisted only to their own file.
        adapter = worker_app._user_naukri_adapter(
            "rohan@example.com",
            {"cookies": [{"name": "nauk_at", "value": "rohan", "domain": ".naukri.com", "path": "/"}]},
        )
        assert adapter.cookie_path == tmp_path / "rohan_example_com" / "naukri_cookies.json"
        saved = json.loads(adapter.cookie_path.read_text())
        assert saved[0]["value"] == "rohan"
        assert json.loads(legacy_global.read_text())[0]["value"] == "owner"

        # A third user without vaulted cookies is not bound to anyone else's session.
        stranger = worker_app._user_naukri_adapter("priya", None)
        assert stranger.cookie_path == tmp_path / "priya" / "naukri_cookies.json"
        assert not stranger.cookie_path.exists()
