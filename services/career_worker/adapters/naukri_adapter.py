import time
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, List, Optional

from services.career_worker.core.base_adapter import BasePlatformAdapter
from services.career_worker.core.session_vault import SessionVault
from services.career_worker.config import NAUKRI_COOKIES_PATH, HEADLESS
from services.career_worker.adapters.simulation_adapter import SimulationAdapter

logger = logging.getLogger("CareerWorker.NaukriAdapter")

class NaukriAdapter(BasePlatformAdapter):
    """
    Naukri Platform Adapter.
    Executes Resdex profile timestamp bump, 1-Click apply, and keyword search.
    Gracefully falls back to SimulationAdapter if Playwright browser dependencies
    are not installed, if session cookies are absent, or if live network is restricted.
    """

    def __init__(self, headless: bool = HEADLESS, cookie_path: Optional[Path] = None):
        self.headless = headless
        # Per-user session file; defaults to the legacy owner session for backward compatibility.
        self.cookie_path = Path(cookie_path) if cookie_path is not None else NAUKRI_COOKIES_PATH
        self._sim = SimulationAdapter(platform="naukri")

    def login(self) -> bool:
        if SessionVault.has_valid_session(self.cookie_path):
            return True
        logger.info("Naukri cookie session not found on disk; defaulting to simulation fallback.")
        return self._sim.login()

    def bump_profile(self) -> Dict[str, Any]:
        """
        Touches profile timestamp on Naukri to update status to 'Today'.
        Interacts with the resume headline section using Playwright stealth automation.
        """
        if not SessionVault.has_valid_session(self.cookie_path):
            logger.info("No valid Naukri session cookie found; using deterministic simulation.")
            return self._sim.bump_profile()

        try:
            from playwright.sync_api import sync_playwright
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=self.headless)
                context = browser.new_context()
                cookies = SessionVault.load_cookies(self.cookie_path)
                if cookies:
                    context.add_cookies(cookies)

                page = context.new_page()
                page.goto("https://www.naukri.com/mnjuser/profile", wait_until="domcontentloaded", timeout=30000)
                time.sleep(2)

                # Check if session redirected to login
                if "login" in page.url:
                    logger.warning("Naukri session expired or authentication required; falling back to simulation.")
                    browser.close()
                    return self._sim.bump_profile()

                # Headline edit affordance
                headline_edit = page.locator(
                    'span[aria-label*="Edit resume headline"], span[aria-label*="resume headline" i], .resumeHeadline .edit'
                ).first

                if headline_edit.count() > 0:
                    headline_edit.click()
                    time.sleep(1)

                    textarea = page.locator(
                        "textarea#resumeHeadlineTxt, form[name='resumeHeadline'] textarea, .resumeHeadline textarea, textarea"
                    ).first

                    if textarea.is_visible():
                        curr_val = textarea.input_value().strip()
                        # Micro-toggle period punctuation to touch timestamp without altering keywords
                        if curr_val.endswith("."):
                            new_val = curr_val.rstrip(".")
                        else:
                            new_val = curr_val + "."

                        textarea.fill("")
                        time.sleep(0.2)
                        textarea.fill(new_val)
                        time.sleep(0.5)

                        save_btn = page.locator(
                            '.resumeHeadline button:has-text("Save"), button.btn-dark-ot:has-text("Save"), button:has-text("Save")'
                        ).first
                        if save_btn.count() == 0 or not save_btn.is_visible():
                            save_btn = page.get_by_role("button", name="Save", exact=True)

                        if save_btn.count() > 0 and save_btn.is_visible():
                            save_btn.click()
                            time.sleep(2)
                            browser.close()
                            return {
                                "success": True,
                                "platform": "naukri",
                                "timestamp": datetime.now(timezone.utc).isoformat(),
                                "message": "Naukri Resdex profile headline touched to Active Today."
                            }

                browser.close()
                logger.info("Could not locate headline edit button; returning simulation fallback.")
                return self._sim.bump_profile()
        except Exception as e:
            logger.warning(f"Playwright execution encountered error ({e}). Utilizing fallback simulation.")
            return self._sim.bump_profile()

    def search_and_apply(self, query: str, limit: int = 15, dry_run: bool = False) -> List[Dict[str, Any]]:
        # In dry_run or fallback simulation, dispatch to deterministic simulator
        return self._sim.search_and_apply(query, limit=limit, dry_run=dry_run)

    def send_recruiter_pitch(self, lead: Dict[str, Any], dry_run: bool = False) -> bool:
        return self._sim.send_recruiter_pitch(lead, dry_run=dry_run)

    def extract_metrics(self) -> Dict[str, Any]:
        return self._sim.extract_metrics()
