from __future__ import annotations

from pathlib import Path
from typing import Any

from knowledge_worker.config import Settings
from knowledge_worker.worker import IngestWorker

from conftest import MockASR, MockOCR, MockScenes


class FakeAPI:
    def __init__(self) -> None:
        self.jobs: list[dict[str, Any]] = []
        self.stored: list[dict[str, Any]] = []
        self.completed: list[str] = []
        self.failed: list[str] = []
        self.heartbeats = 0

    def claim(self, worker_id: str, lease_seconds: int) -> dict[str, Any] | None:
        if not self.jobs:
            return None
        return self.jobs.pop(0)

    def heartbeat(self, job_id: str, worker_id: str, fence: int, lease_seconds: int) -> None:
        self.heartbeats += 1

    def store_ingest(self, job_id: str, worker_id: str, fence: int, ingest: dict[str, Any]) -> dict[str, Any]:
        self.stored.append(ingest)
        return {"status": "ready"}

    def complete(self, job_id: str, worker_id: str, fence: int, result: dict[str, Any] | None = None) -> None:
        self.completed.append(job_id)

    def fail(self, job_id: str, worker_id: str, fence: int, error_code: str, retry: bool = True) -> None:
        self.failed.append(job_id)


def _settings(media_root: Path) -> Settings:
    return Settings(
        api_url="http://example.test",
        worker_token="secret",
        worker_id="w1",
        poll_seconds=0.01,
        lease_seconds=30,
        media_root=str(media_root),
        whisper_model="tiny",
        whisper_device="cpu",
        whisper_compute_type="int8",
        whisper_cpp_bin="whisper-cli",
        ocr_engine="tesseract",
        qdrant_url="http://127.0.0.1:6333",
        qdrant_collection="courseforge_living_video",
        enable_qdrant=False,
    )


def test_worker_poll_processes_job(tmp_path: Path, tiny_media: Path, tiny_frame: Path, fixtures_dir: Path):
    api = FakeAPI()
    api.jobs.append(
        {
            "id": "kjob_1",
            "lesson_id": "lesson",
            "fence": 1,
            "payload": {"source_path": str(tiny_media)},
        }
    )
    worker = IngestWorker(
        _settings(tmp_path),
        api,  # type: ignore[arg-type]
        asr=MockASR(fixtures_dir),
        scenes=MockScenes(tiny_frame),
        ocr=MockOCR(),
        sleep=lambda _s: None,
    )
    assert worker.poll_once() is True
    assert api.heartbeats == 1
    assert len(api.stored) == 1
    assert api.completed == ["kjob_1"]
    assert api.failed == []
    assert worker.poll_once() is False
