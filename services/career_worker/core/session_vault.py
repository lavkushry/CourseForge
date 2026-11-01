import hashlib
import json
import logging
import re
from pathlib import Path
from typing import List, Dict, Any, Optional

logger = logging.getLogger("CareerWorker.SessionVault")

class SessionVault:
    @staticmethod
    def _safe_component(value: Optional[str], default: str) -> str:
        """Maps an id to one safe path component without merging tenants.

        Replacing unsafe characters is lossy: "a/b", "a b" and "a@b" would all
        collapse to "a_b" and silently share a single cookie file. Whenever
        sanitising changes the value, append a deterministic hash of the
        original so distinct user/platform ids can never collide, while
        already-safe ids keep their readable form.
        """
        raw = (value or "").strip()
        if not raw:
            return default
        safe = re.sub(r"[^a-zA-Z0-9_\-]", "_", raw)
        if not safe:
            return default
        if safe != raw:
            digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:10]
            safe = f"{safe}-{digest}"
        return safe

    @staticmethod
    def user_cookie_path(base_dir: Path, user_id: str, platform: str) -> Path:
        """Returns an isolated per-user, per-platform session cookie file path."""
        safe_user = SessionVault._safe_component(user_id, "default")
        safe_platform = SessionVault._safe_component(platform, "naukri")
        path = base_dir / safe_user / f"{safe_platform}_cookies.json"
        # Defence in depth: the resolved path must stay inside base_dir,
        # whatever a caller passes as either argument.
        resolved_base = Path(base_dir).resolve()
        if resolved_base not in path.resolve().parents:
            raise ValueError("cookie path escapes its base directory")
        return path

    @staticmethod
    def load_cookies(cookie_path: Path) -> List[Dict[str, Any]]:
        """Loads session cookies from disk."""
        if not cookie_path.exists():
            logger.info(f"Cookie file not found: {cookie_path}")
            return []
        try:
            with open(cookie_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict) and "cookies" in data and isinstance(data["cookies"], list):
                    return data["cookies"]
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
        try:
            # is_file(), not exists(): a directory at this path would
            # otherwise report a "valid session" on its directory size.
            return cookie_path.is_file() and cookie_path.stat().st_size > 10
        except OSError:
            return False
