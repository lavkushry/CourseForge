from __future__ import annotations

import os
from dataclasses import dataclass

from knowledge_worker import QDRANT_COLLECTION


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass(frozen=True)
class Settings:
    api_url: str
    worker_token: str
    worker_id: str
    poll_seconds: float
    lease_seconds: int
    media_root: str
    whisper_model: str
    whisper_device: str
    whisper_compute_type: str
    whisper_cpp_bin: str
    ocr_engine: str  # tesseract | paddle
    qdrant_url: str
    qdrant_collection: str
    enable_qdrant: bool
    embedder: str
    reranker: str
    embed_dim: int


def load_settings() -> Settings:
    collection = _env("CF_QDRANT_COLLECTION", QDRANT_COLLECTION)
    if collection != QDRANT_COLLECTION:
        # Hard-guard: reject accidental reuse of legacy collections.
        if collection in {"courseforge_chunks", "courseforge_living_video", ""}:
            collection = QDRANT_COLLECTION
    return Settings(
        api_url=_env("CF_KNOWLEDGE_API_URL", "http://127.0.0.1:8090").rstrip("/"),
        worker_token=_env("CF_KNOWLEDGE_WORKER_TOKEN"),
        worker_id=_env("CF_KNOWLEDGE_WORKER_ID", "knowledge-worker-1"),
        poll_seconds=float(_env("CF_KNOWLEDGE_POLL_SECONDS", "3") or "3"),
        lease_seconds=int(_env("CF_KNOWLEDGE_LEASE_SECONDS", "120") or "120"),
        media_root=_env("CF_KNOWLEDGE_MEDIA_ROOT", "/tmp/knowledge-media"),
        whisper_model=_env("CF_WHISPER_MODEL", "tiny"),
        whisper_device=_env("CF_WHISPER_DEVICE", "cpu"),
        whisper_compute_type=_env("CF_WHISPER_COMPUTE_TYPE", "int8"),
        whisper_cpp_bin=_env("CF_WHISPER_CPP_BIN", "whisper-cli"),
        ocr_engine=_env("CF_OCR_ENGINE", "tesseract").lower() or "tesseract",
        qdrant_url=_env("CF_QDRANT_URL", "http://127.0.0.1:6333").rstrip("/"),
        qdrant_collection=collection,
        enable_qdrant=_env("CF_KNOWLEDGE_ENABLE_QDRANT", "false").lower() in {"1", "true", "yes"},
        embedder=_env("CF_KNOWLEDGE_EMBEDDER", "sentence-transformers") or "sentence-transformers",
        reranker=_env("CF_KNOWLEDGE_RERANKER", "cross-encoder") or "cross-encoder",
        embed_dim=int(_env("CF_KNOWLEDGE_EMBED_DIM", "384") or "384"),
    )
