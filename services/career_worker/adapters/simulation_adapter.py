import time
import logging
from typing import Dict, Any, List
from datetime import datetime, timezone

from services.career_worker.core.base_adapter import BasePlatformAdapter

logger = logging.getLogger("CareerWorker.SimulationAdapter")

class SimulationAdapter(BasePlatformAdapter):
    """
    Deterministic Dry-Run Simulation Adapter (Liskov Substitution Principle).
    Simulates platform responses without network calls or headless browser requirements.
    """

    def __init__(self, platform: str = "simulation"):
        self.platform = platform

    def login(self) -> bool:
        logger.info(f"[{self.platform}] Simulated successful authentication.")
        return True

    def bump_profile(self) -> Dict[str, Any]:
        now_iso = datetime.now(timezone.utc).isoformat()
        logger.info(f"[{self.platform}] Simulated Resdex profile touch timestamp to Active Today.")
        return {
            "success": True,
            "platform": self.platform,
            "timestamp": now_iso,
            "message": "Simulated Resdex profile bump: Profile freshness updated to Active Today.",
            "is_dry_run": True
        }

    def search_and_apply(self, query: str, limit: int = 15, dry_run: bool = True) -> List[Dict[str, Any]]:
        logger.info(f"[{self.platform}] Simulating application search and submission for '{query}' (limit={limit}).")
        results = []
        role_title = query.strip() if query and len(query.strip()) <= 50 and "DROP TABLE" not in query else "Azure Data Engineer"
        companies = [
            ("Microsoft", f"Senior {role_title}", "Bengaluru", 94.5),
            ("Deloitte", f"{role_title} Specialist", "Hyderabad", 91.0),
            ("EY GDS", f"{role_title}", "Bengaluru", 88.5),
            ("PwC India", f"Lead {role_title}", "Pune", 89.0),
            ("Wipro GCC", f"{role_title} II", "Bengaluru", 84.0),
            ("Cognizant", f"Staff {role_title}", "Remote", 86.5),
            ("TCS Digital", f"Senior {role_title}", "Hyderabad", 83.0),
            ("Accenture Solutions", f"{role_title}", "Bengaluru", 87.0)
        ]

        count = min(limit, len(companies))
        for i in range(count):
            comp, title, loc, score = companies[i]
            job_id = f"sim_{int(time.time())}_{i+1}"
            results.append({
                "job_id": job_id,
                "platform": self.platform,
                "company": comp,
                "title": title,
                "location": loc,
                "match_score": score,
                "status": "APPLIED_SIMULATION",
                "application_type": "1-Click Direct",
                "is_dry_run": True,
                "applied_at": datetime.now(timezone.utc).isoformat()
            })
        return results

    def send_recruiter_pitch(self, lead: Dict[str, Any], dry_run: bool = True) -> bool:
        recruiter = lead.get("recruiter_name", "Recruiter")
        company = lead.get("company", "Company")
        logger.info(f"[{self.platform}] Simulated sending pitch to {recruiter} at {company}.")
        return True

    def extract_metrics(self) -> Dict[str, Any]:
        return {
            "search_appearances": 185,
            "profile_views": 18,
            "contact_views": 7,
            "recorded_at": datetime.now(timezone.utc).isoformat()
        }
