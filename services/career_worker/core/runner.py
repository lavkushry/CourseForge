#!/usr/bin/env python3
"""
CourseForge Career Studio Core Runner Bridge (`python3 -m core.runner`)
Delegates to `services.career_worker.runner` and emits structured JSON telemetry.
"""

import json
import sys
from pathlib import Path
from datetime import datetime, timezone

WORKER_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = WORKER_DIR.parents[1]

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

from services.career_worker.runner import main as runner_main


def main():
    runner_main()
    telemetry = {
        "status": "ok",
        "runner": "core.runner",
        "argv": sys.argv[1:],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    print(json.dumps(telemetry))


if __name__ == "__main__":
    main()
