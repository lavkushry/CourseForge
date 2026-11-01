import os
import fcntl
import logging
from contextlib import contextmanager
from typing import Generator
from services.career_worker.config import LOCK_FILE

logger = logging.getLogger("CareerWorker.Lock")

@contextmanager
def acquire_worker_lock(path: str = LOCK_FILE, timeout_sec: int = 5) -> Generator[bool, None, None]:
    """
    Acquires an exclusive flock on the specified lock file to prevent overlapping
    browser automation sessions across timers, REST API, and CLI invocations.
    """
    lock_fd = None
    try:
        lock_fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        logger.info(f"Acquired worker process lock: {path}")
        yield True
    except (BlockingIOError, OSError) as e:
        logger.warning(f"Could not acquire worker lock ({e}). Another session is running.")
        yield False
    finally:
        if lock_fd is not None:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
                os.close(lock_fd)
            except Exception:
                pass
