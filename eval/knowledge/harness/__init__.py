"""Living Video Knowledge offline evaluation harness."""

from __future__ import annotations

import sys
from pathlib import Path

__version__ = "0.1.0"

# knowledge_worker lives under services/; keep eval imports working without install.
_WORKER_ROOT = Path(__file__).resolve().parents[3] / "services" / "knowledge-worker"
if _WORKER_ROOT.is_dir() and str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))
