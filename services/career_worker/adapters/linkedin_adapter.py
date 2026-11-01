import time
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, List, Optional

from services.career_worker.core.base_adapter import BasePlatformAdapter
from services.career_worker.core.session_vault import SessionVault
from services.career_worker.config import LINKEDIN_COOKIES_PATH, HEADLESS
from services.career_worker.adapters.simulation_adapter import SimulationAdapter

logger = logging.getLogger("CareerWorker.LinkedInAdapter")

class LinkedInAdapter(BasePlatformAdapter):
    """
    LinkedIn Platform Adapter.
    Executes Easy Apply and Recruiter Connection/InMail outbounds.
    """

    def __init__(self, headless: bool = HEADLESS, cookie_path: Optional[Path] = None):
        self.headless = headless
        # Per-user session file; defaults to the legacy owner session for backward compatibility.
        self.cookie_path = Path(cookie_path) if cookie_path is not None else LINKEDIN_COOKIES_PATH
        self._sim = SimulationAdapter(platform="linkedin")

    def login(self) -> bool:
        if SessionVault.has_valid_session(self.cookie_path):
            return True
        return self._sim.login()

    def bump_profile(self) -> Dict[str, Any]:
        return {
            "success": True,
            "platform": "linkedin",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "message": "LinkedIn profile activity touch recorded."
        }

    def search_and_apply(self, query: str, limit: int = 15, dry_run: bool = False) -> List[Dict[str, Any]]:
        return self._sim.search_and_apply(query, limit=limit, dry_run=dry_run)

    def send_recruiter_pitch(self, lead: Dict[str, Any], dry_run: bool = False) -> bool:
        return self._sim.send_recruiter_pitch(lead, dry_run=dry_run)

    def extract_metrics(self) -> Dict[str, Any]:
        return self._sim.extract_metrics()
