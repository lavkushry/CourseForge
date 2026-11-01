import json
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional

logger = logging.getLogger("CareerWorker.SessionVault")

class SessionVault:
    @staticmethod
    def load_cookies(cookie_path: Path) -> List[Dict[str, Any]]:
        """Loads session cookies from disk."""
        if not cookie_path.exists():
            logger.info(f"Cookie file not found: {cookie_path}")
            return []
        try:
            with open(cookie_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, list) else []
        except Exception as e:
            logger.error(f"Error loading cookies from {cookie_path}: {e}")
            return []

    @staticmethod
    def save_cookies(cookie_path: Path, cookies: List[Dict[str, Any]]) -> bool:
        """Persists session cookies to disk securely."""
        try:
            cookie_path.parent.mkdir(parents=True, exist_ok=True)
            with open(cookie_path, "w", encoding="utf-8") as f:
                json.dump(cookies, f, indent=2)
            cookie_path.chmod(0o600)
            logger.info(f"Saved {len(cookies)} cookies to {cookie_path}")
            return True
        except Exception as e:
            logger.error(f"Failed to save cookies to {cookie_path}: {e}")
            return False

    @staticmethod
    def has_valid_session(cookie_path: Path) -> bool:
        """Quick check if a non-empty cookie file exists."""
        return cookie_path.exists() and cookie_path.stat().st_size > 10
