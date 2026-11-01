"""
Pytest fixtures and configuration for CourseForge Career Studio E2E tests.
"""

import sys
import json
import sqlite3
import pytest
from pathlib import Path
from fastapi.testclient import TestClient

# Path resolution
REPO_ROOT = Path("/Users/lavkushkumar/Desktop/Courses/CourseForge")
RESUME_ROOT = Path("/Users/lavkushkumar/Desktop/Resume")
WORKER_DIR = REPO_ROOT / "services" / "career_worker"

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

from services.career_worker.app import app
from services.career_worker.adapters.simulation_adapter import SimulationAdapter
from services.career_worker.modules.boost.policy import LinUCBPolicy, Action
from services.career_worker.modules.boost.mutator import ProfileMutator
from services.career_worker.modules.boost.keyword_miner import KeywordUtilityMiner
from services.career_worker.modules.goal.pacing import PacingCalculator
from services.career_worker.modules.goal.diagnostics import DiagnosticEngine
from services.career_worker.modules.goal.crm import RecruiterCRM
from services.career_worker.modules.plan.daily_blocks import DailyBlockOrchestrator


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return REPO_ROOT


@pytest.fixture(scope="session")
def resume_root() -> Path:
    return RESUME_ROOT


@pytest.fixture(scope="session")
def sqlite_db_path(resume_root) -> Path:
    return resume_root / "applied_jobs.db"


@pytest.fixture(scope="session")
def outreach_json_path(resume_root) -> Path:
    return resume_root / "outreach_tracker.json"


@pytest.fixture(scope="session")
def migration_sql_path(repo_root) -> Path:
    return repo_root / "backend" / "internal" / "store" / "migrations" / "015_career_studio.sql"


@pytest.fixture(scope="session")
def worker_client():
    return TestClient(app)


@pytest.fixture
def sim_adapter():
    return SimulationAdapter(platform="simulation")


@pytest.fixture
def linucb_policy():
    return LinUCBPolicy(alpha=0.2)


@pytest.fixture
def profile_mutator():
    return ProfileMutator()


@pytest.fixture
def recruiter_crm():
    return RecruiterCRM()


@pytest.fixture
def block_orchestrator(sim_adapter):
    return DailyBlockOrchestrator(sim_adapter)


@pytest.fixture
def sample_job_record():
    return {
        "job_id": "TEST_JOB_99999",
        "platform": "naukri",
        "company": "Amazon Web Services",
        "title": "Lead Azure Data Engineer",
        "location": "Bengaluru",
        "experience_req": "2-4 Yrs",
        "match_score": 88.5,
        "status": "APPLIED",
        "application_type": "1-Click Direct",
        "job_url": "https://www.naukri.com/job-listings-99999",
        "applicant_email": "lav84095@gmail.com",
        "policy_version": "v2.1-linucb",
        "is_dry_run": True,
        "is_backfill": 0
    }
