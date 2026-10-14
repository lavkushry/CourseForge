"""Build chapters + multimodal embeddings after ASR/OCR ingest."""

from __future__ import annotations

import logging
from typing import Any

from knowledge_worker.chaptering import chapters_as_payload, text_tiling_chapters
from knowledge_worker.chunking import chunks_as_payload, build_multimodal_chunks
from knowledge_worker.embedder import Embedder, HashEmbedder

log = logging.getLogger(__name__)


def build_index_artifacts(
    segments: list[dict[str, Any]],
    keyframes: list[dict[str, Any]],
    *,
    embedder: Embedder | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[list[float]]]:
    # Tests inject HashEmbedder; production workers pass OllamaEmbedder.
    embedder = embedder or HashEmbedder()
    chapters = chapters_as_payload(text_tiling_chapters(segments, embedder))
    chunks = chunks_as_payload(build_multimodal_chunks(segments, keyframes))
    vectors: list[list[float]] = []
    if chunks:
        vectors = embedder.embed([c["text"] for c in chunks])
    return chapters, chunks, vectors
