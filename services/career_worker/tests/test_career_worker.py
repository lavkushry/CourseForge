import pytest
from datetime import datetime
from fastapi.testclient import TestClient

from services.career_worker.adapters.simulation_adapter import SimulationAdapter
from services.career_worker.modules.boost.policy import LinUCBPolicy, Action
from services.career_worker.modules.boost.mutator import ProfileMutator
from services.career_worker.modules.boost.keyword_miner import KeywordUtilityMiner
from services.career_worker.modules.goal.pacing import PacingCalculator
from services.career_worker.modules.goal.diagnostics import DiagnosticEngine
from services.career_worker.modules.goal.crm import RecruiterCRM
from services.career_worker.modules.plan.daily_blocks import DailyBlockOrchestrator
from services.career_worker.app import app

client = TestClient(app)

def test_simulation_adapter():
    adapter = SimulationAdapter(platform="naukri")
    assert adapter.login() is True

    bump = adapter.bump_profile()
    assert bump["success"] is True
    assert "Active Today" in bump["message"]

    apps = adapter.search_and_apply("Azure Data Engineer", limit=5, dry_run=True)
    assert len(apps) == 5
    assert apps[0]["match_score"] >= 70.0

    pitch_ok = adapter.send_recruiter_pitch({"recruiter_name": "Test", "company": "GCC"}, dry_run=True)
    assert pitch_ok is True

    metrics = adapter.extract_metrics()
    assert metrics["search_appearances"] > 0
    assert metrics["profile_views"] > 0

def test_linucb_policy():
    policy = LinUCBPolicy(alpha=0.2)
    job = {
        "match_score": 85.0,
        "required_yoe": 2.5,
        "posting_age_hours": 12.0,
        "company": "Microsoft",
        "platform": "naukri",
        "skill_overlap": 0.9,
        "salary_lpa": 24.0
    }

    ctx = policy.extract_context(job)
    assert len(ctx) == 7
    for val in ctx:
        assert 0.0 <= val <= 1.0

    action, max_p, scores = policy.select_action(ctx)
    assert action in (Action.APPLY, Action.SKIP, Action.DEFER_TO_REVIEW)
    assert "APPLY" in scores

    # Test update
    policy.update(Action.APPLY, 1.0, ctx)
    assert policy.decisions_count == 1

def test_profile_mutator_whitelist_and_blacklist():
    mutator = ProfileMutator()

    # Valid headline
    valid_hl = mutator.generate_optimized_headline()
    ok, msg = mutator.validate_headline_mutation("Old Headline", valid_hl)
    assert ok is True
    assert len(valid_hl) <= 250

    # Blacklist violation: inflating YOE to 8
    bad_hl = "Senior Azure Data Engineer | 8 YOE | Microsoft"
    ok, msg = mutator.validate_headline_mutation("Old Headline", bad_hl)
    assert ok is False
    assert "YOE" in msg

    # Blacklist violation: inflating notice to 60 days
    bad_notice = "Azure Data Engineer | 2.5 YOE | 60 days notice"
    ok, msg = mutator.validate_headline_mutation("Old Headline", bad_notice)
    assert ok is False
    assert "notice" in msg.lower()

def test_keyword_miner():
    utilities = KeywordUtilityMiner.calculate_utilities()
    assert len(utilities) > 0
    # Top utility should be sorted descending
    assert utilities[0]["utility_score"] >= utilities[-1]["utility_score"]

def test_pacing_and_diagnostics():
    # 5 calls target test
    ratio_3 = PacingCalculator.calculate_pacing_ratio(3)
    assert ratio_3 == 0.60  # 3 / 5 = 0.6

    ratio_5 = PacingCalculator.calculate_pacing_ratio(5)
    assert ratio_5 == 1.00  # 5 / 5 = 1.0

    # Bottleneck evaluation test
    low_metrics = {
        "search_appearances": 80,       # < 150 -> LOW_SEARCH_APPEARANCES
        "contact_views": 2,
        "applications_today": 12,       # < 25 -> LOW_APPLICATION_VELOCITY
        "outreaches_today": 5,          # < 10 -> LOW_OUTREACH_VOLUME
        "calls_scheduled_today": 1      # < 5 -> LOW_CALL_CONVERSION
    }
    alerts = DiagnosticEngine.evaluate(low_metrics)
    codes = [a["code"] for a in alerts]
    assert "LOW_SEARCH_APPEARANCES" in codes
    assert "LOW_APPLICATION_VELOCITY" in codes
    assert "LOW_OUTREACH_VOLUME" in codes
    assert "LOW_CALL_CONVERSION" in codes

def test_recruiter_crm_note_limits():
    crm = RecruiterCRM()
    note = crm.generate_connection_note_300("Priya Sharma", "Walmart Global Tech")
    assert len(note) <= 300
    assert "Lavkush" in note
    assert "15d notice" in note or "15" in note

def test_daily_blocks_orchestrator():
    adapter = SimulationAdapter(platform="simulation")
    orch = DailyBlockOrchestrator(adapter)

    b1 = orch.execute_block(1, dry_run=True)
    assert b1["block"] == 1
    assert len(b1["tasks_completed"]) >= 3

    b2 = orch.execute_block(2, dry_run=True)
    assert b2["block"] == 2
    assert b2["outreach_count"] == 10

    b3 = orch.execute_block(3, dry_run=True)
    assert b3["block"] == 3

def test_fastapi_endpoints():
    r_health = client.get("/health")
    assert r_health.status_code == 200
    assert r_health.json()["status"] == "healthy"

    r_bump = client.post("/execute/bump", json={"user_id": "lavkush", "dry_run": True})
    assert r_bump.status_code == 200
    assert r_bump.json()["success"] is True

    r_apply = client.post("/execute/apply", json={"user_id": "lavkush", "block": 1, "dry_run": True})
    assert r_apply.status_code == 200
    assert r_apply.json()["applied_count"] > 0

    r_outreach = client.post("/execute/outreach", json={"user_id": "lavkush", "count": 10, "dry_run": True})
    assert r_outreach.status_code == 200
    assert r_outreach.json()["outreach_count"] == 10

    r_pacing = client.get("/evaluate/pacing?calls=2&apps=20&outreach=8")
    assert r_pacing.status_code == 200
    data = r_pacing.json()
    assert "pacing" in data
    assert "bottlenecks" in data

    # Universal multi-profile override test (e.g., Backend Engineer in Go & Kubernetes)
    backend_profile = {
        "user_id": "rohan",
        "full_name": "Rohan Verma",
        "target_role": "Senior Backend Engineer",
        "primary_track_id": "backend",
        "total_yoe": 4.0,
        "notice_period_days": 30,
        "target_ctc_range": "₹35–45 LPA",
        "primary_skills": ["Go", "Kubernetes", "PostgreSQL", "gRPC", "Kafka"],
        "whitelist_headline_tokens": ["Senior", "Backend", "Engineer", "Go", "Kubernetes", "PostgreSQL", "gRPC", "Kafka", "30", "Days"]
    }
    r_bump_custom = client.post("/execute/bump", json={"user_id": "rohan", "dry_run": True, "profile": backend_profile})
    assert r_bump_custom.status_code == 200
    assert r_bump_custom.json()["success"] is True
    assert "Senior Backend Engineer" in r_bump_custom.json()["message"]

    r_outreach_custom = client.post("/execute/outreach", json={"user_id": "rohan", "count": 5, "dry_run": True, "profile": backend_profile})
    assert r_outreach_custom.status_code == 200
    assert r_outreach_custom.json()["outreach_count"] == 5
    assert "Senior Backend Engineer" in r_outreach_custom.json()["message"]
