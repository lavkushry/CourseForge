"""Poll knowledge_jobs via the Go API and run ingest + retrieval indexing."""

from __future__ import annotations

import logging
import tempfile
import time
from pathlib import Path
from typing import Any, Callable

from knowledge_worker.api_client import KnowledgeAPI
from knowledge_worker.asr import ASREngine, build_asr
from knowledge_worker.config import Settings, load_settings
from knowledge_worker.embedder import Embedder, build_embedder
from knowledge_worker.index_pipeline import build_index_artifacts
from knowledge_worker.ocr import OCREngine, build_ocr
from knowledge_worker.pipeline import resolve_media_path, run_ingest
from knowledge_worker.qdrant_store import ensure_knowledge_collection, upsert_chunks
from knowledge_worker.scenes import SceneDetector, build_scene_detector

log = logging.getLogger(__name__)


class IngestWorker:
    def __init__(
        self,
        settings: Settings,
        api: KnowledgeAPI,
        *,
        asr: ASREngine | None = None,
        scenes: SceneDetector | None = None,
        ocr: OCREngine | None = None,
        embedder: Embedder | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.settings = settings
        self.api = api
        self.asr = asr or build_asr(
            model_size=settings.whisper_model,
            device=settings.whisper_device,
            compute_type=settings.whisper_compute_type,
            whisper_cpp_bin=settings.whisper_cpp_bin,
        )
        self.scenes = scenes or build_scene_detector()
        self.ocr = ocr or build_ocr(settings.ocr_engine)
        self.embedder = embedder or build_embedder(settings.embedder, dim=settings.embed_dim)
        self._sleep = sleep

    def process_job(self, job: dict[str, Any]) -> None:
        job_id = str(job["id"])
        lesson_id = str(job.get("lesson_id") or "")
        worker_id = self.settings.worker_id
        fence = int(job["fence"])
        payload = job.get("payload") or {}
        media_root = Path(self.settings.media_root)
        media_path = resolve_media_path(payload, media_root)
        self.api.heartbeat(job_id, worker_id, fence, self.settings.lease_seconds)
        with tempfile.TemporaryDirectory(prefix=f"kw-{job_id}-") as tmp:
            bundle = run_ingest(
                media_path,
                Path(tmp),
                asr=self.asr,
                scenes=self.scenes,
                ocr=self.ocr,
            )
            self.api.store_ingest(job_id, worker_id, fence, bundle.as_payload())
            chapters, chunks, vectors = build_index_artifacts(
                bundle.segments,
                bundle.keyframes,
                embedder=self.embedder,
            )
            # Assign stable chunk ids before Qdrant upsert / Postgres index.
            for chunk in chunks:
                chunk["id"] = f"kc_{lesson_id}_{chunk['ordinal']}"
            if self.settings.enable_qdrant and vectors:
                self._upsert_qdrant(lesson_id, chunks, vectors)
            self.api.store_index(
                job_id,
                worker_id,
                fence,
                chapters=chapters,
                chunks=chunks,
                embedder=getattr(self.embedder, "name", ""),
            )
        self.api.complete(
            job_id,
            worker_id,
            fence,
            {
                "lesson_id": lesson_id,
                "word_count": len(bundle.words),
                "segment_count": len(bundle.segments),
                "keyframe_count": len(bundle.keyframes),
                "chapter_count": len(chapters),
                "chunk_count": len(chunks),
                "asr_engine": bundle.asr_engine,
                "scene_engine": bundle.scene_engine,
                "ocr_engine": bundle.ocr_engine,
                "embedder": getattr(self.embedder, "name", ""),
            },
        )

    def _upsert_qdrant(
        self,
        lesson_id: str,
        chunks: list[dict[str, Any]],
        vectors: list[list[float]],
    ) -> None:
        try:
            from qdrant_client import QdrantClient  # type: ignore
        except Exception as exc:
            log.warning("qdrant client unavailable: %s", exc)
            return
        client = QdrantClient(url=self.settings.qdrant_url, timeout=30, check_compatibility=False)
        dim = len(vectors[0]) if vectors else self.embedder.dimension()
        ensure_knowledge_collection(client, dimension=dim, collection=self.settings.qdrant_collection)
        upsert_chunks(
            client,
            lesson_id=lesson_id,
            chunks=chunks,
            vectors=vectors,
            collection=self.settings.qdrant_collection,
        )

    def poll_once(self) -> bool:
        job = self.api.claim(self.settings.worker_id, self.settings.lease_seconds)
        if not job:
            return False
        try:
            self.process_job(job)
        except Exception as exc:
            log.exception("ingest failed for %s: %s", job.get("id"), exc)
            code = type(exc).__name__[:64] or "ingest_failed"
            try:
                self.api.fail(str(job["id"]), self.settings.worker_id, int(job["fence"]), code, retry=True)
            except Exception:
                log.exception("failed to report job failure")
        return True

    def run_forever(self) -> None:
        log.info(
            "knowledge worker starting worker_id=%s api=%s collection=%s embedder=%s",
            self.settings.worker_id,
            self.settings.api_url,
            self.settings.qdrant_collection,
            getattr(self.embedder, "name", ""),
        )
        while True:
            worked = False
            try:
                worked = self.poll_once()
            except Exception:
                log.exception("poll loop error")
            if not worked:
                self._sleep(self.settings.poll_seconds)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    settings = load_settings()
    if not settings.worker_token:
        raise SystemExit("CF_KNOWLEDGE_WORKER_TOKEN is required")
    api = KnowledgeAPI(settings.api_url, settings.worker_token)
    try:
        IngestWorker(settings, api).run_forever()
    finally:
        api.close()
