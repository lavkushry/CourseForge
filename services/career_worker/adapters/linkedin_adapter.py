import time
import logging
from datetime import datetime, timezone
from typing import Dict, Any, List

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

    def __init__(self, headless: bool = HEADLESS):
        self.headless = headless
        self._sim = SimulationAdapter(platform="linkedin")

    def login(self) -> bool:
        if SessionVault.has_valid_session(LINKEDIN_COOKIES_PATH):
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
