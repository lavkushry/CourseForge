from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from knowledge_worker.config import Settings
from knowledge_worker.embedder import HashEmbedder
from knowledge_worker.worker import IngestWorker

from conftest import MockASR, MockOCR, MockScenes


class FakeAPI:
    def __init__(self) -> None:
        self.jobs: list[dict[str, Any]] = []
        self.stored: list[dict[str, Any]] = []
        self.indexed: list[dict[str, Any]] = []
        self.completed: list[str] = []
        self.failed: list[str] = []
        self.results: list[dict[str, Any]] = []
        self.heartbeats = 0
        self.spatial: list[list[dict[str, Any]]] = []
        self.spatial_error: Exception | None = None

    def claim(self, worker_id: str, lease_seconds: int) -> dict[str, Any] | None:
        if not self.jobs:
            return None
        return self.jobs.pop(0)

    def heartbeat(self, job_id: str, worker_id: str, fence: int, lease_seconds: int) -> None:
        self.heartbeats += 1

    def store_ingest(self, job_id: str, worker_id: str, fence: int, ingest: dict[str, Any]) -> dict[str, Any]:
        self.stored.append(ingest)
        return {"status": "ready"}

    def store_index(
        self,
        job_id: str,
        worker_id: str,
        fence: int,
        *,
        chapters: list[dict[str, Any]],
        chunks: list[dict[str, Any]],
        embedder: str = "",
        embed_dim: int = 0,
    ) -> dict[str, Any]:
        self.indexed.append(
            {"chapters": chapters, "chunks": chunks, "embedder": embedder, "embed_dim": embed_dim}
        )
        return {"chapter_count": len(chapters), "chunk_count": len(chunks)}

    def store_spatial(
        self,
        job_id: str,
        worker_id: str,
        fence: int,
        candidates: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if self.spatial_error:
            raise self.spatial_error
        self.spatial.append(candidates)
        return {"candidate_count": len(candidates)}

    def complete(self, job_id: str, worker_id: str, fence: int, result: dict[str, Any] | None = None) -> None:
        self.completed.append(job_id)
        self.results.append(result or {})

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
        qdrant_collection="courseforge_knowledge",
        enable_qdrant=False,
        embedder="hash",
        reranker="lexical",
        embed_dim=32,
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
        embedder=HashEmbedder(dim=32),
        sleep=lambda _s: None,
    )
    assert worker.poll_once() is True
    assert api.heartbeats == 1
    assert len(api.stored) == 1
    assert len(api.indexed) == 1
    assert api.indexed[0]["chunks"]
    assert api.completed == ["kjob_1"]
    assert api.failed == []
    assert api.spatial == [[]]
    assert "spatial_gates" not in api.results[0]
    assert worker.poll_once() is False


def test_spatial_store_failure_does_not_fail_indexing(tmp_path: Path, tiny_media: Path, tiny_frame: Path, fixtures_dir: Path):
    api = FakeAPI()
    api.spatial_error = RuntimeError("spatial store unavailable")
    api.jobs.append(
        {
            "id": "kjob_spatial",
            "lesson_id": "lesson",
            "fence": 3,
            "payload": {"source_path": str(tiny_media)},
        }
    )
    worker = IngestWorker(
        _settings(tmp_path),
        api,  # type: ignore[arg-type]
        asr=MockASR(fixtures_dir),
        scenes=MockScenes(tiny_frame),
        ocr=MockOCR(),
        embedder=HashEmbedder(dim=32),
        sleep=lambda _s: None,
    )
    assert worker.poll_once() is True
    assert api.completed == ["kjob_spatial"]
    assert api.failed == []
    assert api.spatial == []


def test_worker_gates_spatial_assets_before_completion(tmp_path: Path, tiny_media: Path, tiny_frame: Path, fixtures_dir: Path):
    cases = json.loads((fixtures_dir / "spatial_confidence_cases.json").read_text(encoding="utf-8"))
    api = FakeAPI()
    api.jobs.append(
        {
            "id": "kjob_spatial_gate",
            "lesson_id": "lec-btree-01",
            "fence": 2,
            "payload": {
                "source_path": str(tiny_media),
                "spatial_candidates": [cases["clean"]["asset"], cases["noisy"]["asset"]],
            },
        }
    )
    worker = IngestWorker(
        _settings(tmp_path),
        api,  # type: ignore[arg-type]
        asr=MockASR(fixtures_dir),
        scenes=MockScenes(tiny_frame),
        ocr=MockOCR(),
        embedder=HashEmbedder(dim=32),
        sleep=lambda _s: None,
    )
    assert worker.poll_once() is True
    assert api.failed == []
    gates = {item["asset_id"]: item for item in api.results[0]["spatial_gates"]}
    assert gates["spatial-btree-clean"]["decision"] == "release"
    assert gates["spatial-btree-clean"]["show_asset"] is True
    assert gates["spatial-btree-noisy"]["decision"] == "hold"
    assert gates["spatial-btree-noisy"]["show_asset"] is False
    assert gates["spatial-btree-noisy"]["source_href"] == "#learning/lec-btree-01?t=210"
