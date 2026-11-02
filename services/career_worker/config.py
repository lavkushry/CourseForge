import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
ROOT_DIR = BASE_DIR.parents[1]

# Server & Execution Config
HOST = os.getenv("CF_CAREER_HOST", "0.0.0.0")
PORT = int(os.getenv("CF_CAREER_PORT", "18095"))
HEADLESS = os.getenv("CF_CAREER_HEADLESS", "true").lower() in ("true", "1", "yes")
DRY_RUN = os.getenv("CF_CAREER_DRY_RUN", "false").lower() in ("true", "1", "yes")

# Database URL (PostgreSQL)
DATABASE_URL = os.getenv(
    "CF_DATABASE_URL",
    os.getenv("DATABASE_URL", "postgres://courseforge:courseforge@localhost:5432/courseforge_rewrite?sslmode=disable")
)

# Active User & Profile
DEFAULT_USER_ID = os.getenv("CF_CAREER_USER_ID", "lavkush")
CANDIDATE_NAME = "Lavkush Kumar"
CANDIDATE_EMAIL = "lav84095@gmail.com"
CANDIDATE_PHONE = "+91-9122036484"
TARGET_ROLE = "Azure Data Engineer"
CURRENT_CTC_LPA = 12.0
TARGET_MIN_CTC_LPA = 20.0
TARGET_MAX_CTC_LPA = 25.0
NOTICE_PERIOD_DAYS = 15
TARGET_CALLS_PER_DAY = 5.0

# Session & Lock Files
LOCK_FILE = os.getenv("CF_CAREER_LOCK_FILE", "/tmp/courseforge_career.lock")
COOKIES_DIR = Path(os.getenv("CF_CAREER_COOKIES_DIR", str(BASE_DIR / "cookies")))
COOKIES_DIR.mkdir(parents=True, exist_ok=True)

def resolve_cookie_path(platform: str) -> Path:
    """
    Dynamically locates active session cookies across:
    1. CF_CAREER_COOKIES_DIR or local cookies directory
    2. Linux production paths (/home/ubuntu/Resume/<platform>_system/session_cookies.json)
    3. macOS desktop paths (~/Desktop/Resume/<platform>_system/session_cookies.json)
    """
    system_dir = f"{platform}_system"
    candidates = [
        COOKIES_DIR / f"{platform}_cookies.json",
        Path("/home/ubuntu/Resume") / system_dir / "session_cookies.json",
        Path.home() / "Desktop" / "Resume" / system_dir / "session_cookies.json",
        Path.home() / "Resume" / system_dir / "session_cookies.json",
    ]
    for c in candidates:
        if c.exists() and c.stat().st_size > 10:
            return c
    return COOKIES_DIR / f"{platform}_cookies.json"

NAUKRI_COOKIES_PATH = resolve_cookie_path("naukri")
LINKEDIN_COOKIES_PATH = resolve_cookie_path("linkedin")

LEGACY_OWNER_USER_IDS = {"lavkush", "usr_lavkush"}


def resolve_user_cookie_path(user_id: str, platform: str) -> Path:
    """
    Returns the session cookie file owned by ``user_id`` for ``platform``.

    Each user gets an isolated file at ``COOKIES_DIR/<user>/<platform>_cookies.json``.
    Only the legacy owner account may fall back to the pre-merge global session files;
    every other user without their own vaulted session gets a non-existent path, which
    makes adapters fall back to simulation instead of borrowing someone else's account.
    """
    from services.career_worker.core.session_vault import SessionVault

    # Sanitise with the vault's shared helper: plain character replacement
    # is lossy ("a/b", "a b" and "a@b" all collapse to "a_b" and would
    # silently share one tenant's cookie file), so ids altered by sanitising
    # get a deterministic hash suffix. This keeps the path built here
    # identical to SessionVault.user_cookie_path(COOKIES_DIR, ...).
    safe_user = SessionVault._safe_component(user_id, "default")
    safe_platform = SessionVault._safe_component(platform, "naukri")
    per_user = COOKIES_DIR / safe_user / f"{safe_platform}_cookies.json"
    if per_user.exists() and per_user.stat().st_size > 10:
        return per_user
    if (user_id or "").strip().lower() in LEGACY_OWNER_USER_IDS:
        return resolve_cookie_path(safe_platform)
    return per_user
