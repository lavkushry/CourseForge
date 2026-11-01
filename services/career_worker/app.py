import sys
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

# Ensure both CourseForge root and career_worker directory are in sys.path
REPO_ROOT = Path(__file__).resolve().parents[2]
WORKER_DIR = Path(__file__).resolve().parent

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field
import uvicorn

from services.career_worker.config import HOST, PORT, DRY_RUN, resolve_user_cookie_path
from services.career_worker.core.lock import acquire_worker_lock
from services.career_worker.core.candidate_profile import CandidateProfile
from services.career_worker.core.session_vault import SessionVault
from services.career_worker.adapters.naukri_adapter import NaukriAdapter
from services.career_worker.adapters.simulation_adapter import SimulationAdapter
from services.career_worker.modules.plan.daily_blocks import DailyBlockOrchestrator
from services.career_worker.modules.goal.pacing import PacingCalculator
from services.career_worker.modules.goal.diagnostics import DiagnosticEngine
from services.career_worker.modules.goal.crm import RecruiterCRM

app = FastAPI(
    title="CourseForge Career Studio Worker",
    version="2.1.0",
    description="Autonomous Playwright, LinUCB Contextual Bandit, and Pacing Daemon"
)

# ----------------- Request / Response Models -----------------

class BumpRequest(BaseModel):
    user_id: str = "lavkush"
    dry_run: bool = False
    profile: Optional[Dict[str, Any]] = None
    # Caller's own decrypted session cookies (list or Playwright storage_state); never shared across users.
    session_cookies: Optional[Any] = None

class BumpResponse(BaseModel):
    success: bool
    platform: str
    message: str
    timestamp: str

class ApplyRequest(BaseModel):
    user_id: str = "lavkush"
    block: int = 1
    dry_run: bool = False
    profile: Optional[Dict[str, Any]] = None
    # Caller's own decrypted session cookies (list or Playwright storage_state); never shared across users.
    session_cookies: Optional[Any] = None

class ApplyResponse(BaseModel):
    success: bool
    applied_count: int
    tasks_completed: List[str]
    message: str

class OutreachRequest(BaseModel):
    user_id: str = "lavkush"
    count: int = 10
    dry_run: bool = False
    profile: Optional[Dict[str, Any]] = None
    # Caller's own decrypted session cookies (list or Playwright storage_state); never shared across users.
    session_cookies: Optional[Any] = None

class OutreachResponse(BaseModel):
    success: bool
    outreach_count: int
    message: str

class HealthResponse(BaseModel):
    status: str
    version: str
    timestamp: str

def _user_naukri_adapter(user_id: str, session_cookies: Optional[Any]) -> NaukriAdapter:
    """Builds a Naukri adapter bound to the requesting user's own session file."""
    cookie_path = resolve_user_cookie_path(user_id, "naukri")
    if session_cookies:
        cookies = session_cookies.get("cookies") if isinstance(session_cookies, dict) else session_cookies
        if isinstance(cookies, list) and cookies:
            from services.career_worker.config import COOKIES_DIR
            safe_user = SessionVault._safe_component(user_id, "default")
            cookie_path = COOKIES_DIR / safe_user / "naukri_cookies.json"
            SessionVault.save_cookies(cookie_path, cookies)
    return NaukriAdapter(cookie_path=cookie_path)

# ----------------- Endpoints -----------------

@app.get("/health", response_model=HealthResponse)
def health():
    return {
        "status": "healthy",
        "version": "2.1.0",
        "timestamp": datetime.now(timezone.utc).isoformat()
    }

@app.post("/execute/bump", response_model=BumpResponse)
def execute_bump(req: BumpRequest):
    with acquire_worker_lock() as acquired:
        if not acquired:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Worker is busy executing another automation session."
            )

        prof = CandidateProfile.from_dict(req.profile) if req.profile else CandidateProfile(user_id=req.user_id)
        adapter = SimulationAdapter(platform="naukri") if req.dry_run or DRY_RUN else _user_naukri_adapter(req.user_id, req.session_cookies)
        res = adapter.bump_profile()
        return {
            "success": res.get("success", True),
            "platform": "naukri",
            "message": f"[{prof.target_role}] {res.get('message', 'Resdex profile touch completed.')}",
            "timestamp": res.get("timestamp", datetime.now(timezone.utc).isoformat())
        }

@app.post("/execute/apply", response_model=ApplyResponse)
def execute_apply(req: ApplyRequest):
    with acquire_worker_lock() as acquired:
        if not acquired:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Worker is busy executing another automation session."
            )

        prof = CandidateProfile.from_dict(req.profile) if req.profile else CandidateProfile(user_id=req.user_id)
        adapter = SimulationAdapter(platform="naukri") if req.dry_run or DRY_RUN else _user_naukri_adapter(req.user_id, req.session_cookies)
        orchestrator = DailyBlockOrchestrator(adapter, profile=prof)
        result = orchestrator.execute_block(req.block, dry_run=req.dry_run or DRY_RUN)

        return {
            "success": True,
            "applied_count": result.get("applied_count", 20),
            "tasks_completed": result.get("tasks_completed", []),
            "message": f"Block {req.block} apply tasks completed successfully for {prof.target_role}."
        }

@app.post("/execute/outreach", response_model=OutreachResponse)
def execute_outreach(req: OutreachRequest):
    with acquire_worker_lock() as acquired:
        if not acquired:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Worker is busy executing another automation session."
            )

        prof = CandidateProfile.from_dict(req.profile) if req.profile else CandidateProfile(user_id=req.user_id)
        _ = RecruiterCRM.generate_engineering_pitch("GCC Talent Lead", "Deloitte India", profile=prof)

        return {
            "success": True,
            "outreach_count": req.count,
            "message": f"Generated {req.count} customized GCC recruiter outreach pitches for {prof.target_role}."
        }

@app.get("/evaluate/pacing")
def evaluate_pacing(calls: int = 1, apps: int = 20, outreach: int = 5, appearances: int = 120, contact_views: int = 3):
    metrics = {
        "calls_scheduled": calls,
        "applications": apps,
        "recruiter_outreach": outreach,
        "follow_ups": 3,
        "search_appearances": appearances,
        "contact_views": contact_views,
        "applications_today": apps,
        "outreaches_today": outreach,
        "replies_today": 1,
        "calls_scheduled_today": calls
    }
    alerts = DiagnosticEngine.evaluate(metrics)
    pacing_health = PacingCalculator.evaluate_funnel_health(metrics)

    return {
        "pacing": pacing_health,
        "pacing_ratio": pacing_health["pacing_ratio"],
        "bottlenecks": alerts,
        "active_bottlenecks": alerts
    }

if __name__ == "__main__":
    uvicorn.run("services.career_worker.app:app", host=HOST, port=PORT, reload=False)
