"""Build chapters + multimodal embeddings after ASR/OCR ingest."""

from __future__ import annotations

import logging
from typing import Any

from knowledge_worker.chaptering import chapters_as_payload, text_tiling_chapters
from knowledge_worker.chunking import chunks_as_payload, build_multimodal_chunks
from knowledge_worker.embedder import Embedder, HashEmbedder
from knowledge_worker.spatial_confidence import collect_spatial_assets, gate_spatial_asset

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


def gate_spatial_for_index(
    lecture_id: str,
    segments: list[dict[str, Any]] | None,
    keyframes: list[dict[str, Any]] | None,
    chapters: list[dict[str, Any]] | None,
    payload: Any = None,
) -> list[dict[str, Any]]:
    """Gate spatial assets before a student can see them as lecture content.

    Chapters are the concept-graph nodes available while indexing (titles and
    summaries). Candidates are read from the job payload and from keyframe
    ``spatial`` blocks. No candidates means nothing is released.
    """
    assets = collect_spatial_assets(payload, keyframes)
    return [
        gate_spatial_asset(
            asset,
            lecture_id=lecture_id,
            segments=segments,
            keyframes=keyframes,
            concepts=chapters,
        )
        for asset in assets
    ]
