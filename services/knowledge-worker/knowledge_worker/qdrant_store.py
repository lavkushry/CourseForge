"""Qdrant helpers for the dedicated Living Video Knowledge collection only."""

from __future__ import annotations

import logging
import uuid
from typing import Any, Sequence

from knowledge_worker import QDRANT_COLLECTION

log = logging.getLogger(__name__)


def ensure_knowledge_collection(client: Any, dimension: int, collection: str = QDRANT_COLLECTION) -> None:
    """Create the dedicated collection if missing. Never mutate other collections."""
    if collection != QDRANT_COLLECTION:
        raise ValueError(f"refusing non-dedicated Qdrant collection: {collection}")
    if hasattr(client, "collection_exists"):
        exists = client.collection_exists(collection)
    else:
        names = {c.name for c in client.get_collections().collections}
        exists = collection in names
    if exists:
        return
    try:
        from qdrant_client import models  # type: ignore

        vectors_config = models.VectorParams(size=dimension, distance=models.Distance.COSINE)
    except ImportError:
        vectors_config = {"size": dimension, "distance": "Cosine"}
    client.create_collection(collection_name=collection, vectors_config=vectors_config)
    log.info("created qdrant collection %s dim=%s", collection, dimension)


# Back-compat alias used by older call sites during the rename window.
ensure_living_video_collection = ensure_knowledge_collection


def _point_id(chunk_id: str) -> str:
    """Qdrant accepts UUID or unsigned int; derive a stable UUID5 from chunk id."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"courseforge-knowledge:{chunk_id}"))


def upsert_chunks(
    client: Any,
    *,
    lesson_id: str,
    chunks: Sequence[dict[str, Any]],
    vectors: Sequence[Sequence[float]],
    collection: str = QDRANT_COLLECTION,
) -> int:
    if collection != QDRANT_COLLECTION:
        raise ValueError(f"refusing non-dedicated Qdrant collection: {collection}")
    if len(chunks) != len(vectors):
        raise ValueError("chunks/vectors length mismatch")
    if not chunks:
        return 0
    try:
        from qdrant_client import models  # type: ignore
    except ImportError as exc:
        raise RuntimeError("qdrant_client required for upsert") from exc

    # Drop prior points for this lesson before writing the new index.
    client.delete(
        collection_name=collection,
        points_selector=models.FilterSelector(
            filter=models.Filter(
                must=[models.FieldCondition(key="lesson_id", match=models.MatchValue(value=lesson_id))]
            )
        ),
        wait=True,
    )

    points = []
    for chunk, vector in zip(chunks, vectors):
        chunk_id = str(chunk.get("id") or f"{lesson_id}:{chunk['ordinal']}")
        points.append(
            models.PointStruct(
                id=_point_id(chunk_id),
                vector=list(vector),
                payload={
                    "lesson_id": lesson_id,
                    "chunk_id": chunk_id,
                    "ordinal": int(chunk["ordinal"]),
                    "start_ms": int(chunk["start_ms"]),
                    "end_ms": int(chunk["end_ms"]),
                    "text": str(chunk["text"]),
                    "source": str(chunk.get("source") or "multimodal"),
                },
            )
        )
    client.upsert(collection_name=collection, points=points, wait=True)
    return len(points)


def search_dense(
    client: Any,
    *,
    vector: Sequence[float],
    lesson_id: str,
    limit: int = 8,
    collection: str = QDRANT_COLLECTION,
) -> list[dict[str, Any]]:
    if collection != QDRANT_COLLECTION:
        raise ValueError(f"refusing non-dedicated Qdrant collection: {collection}")
    try:
        from qdrant_client import models  # type: ignore
    except ImportError as exc:
        raise RuntimeError("qdrant_client required for search") from exc

    if hasattr(client, "query_points"):
        result = client.query_points(
            collection_name=collection,
            query=list(vector),
            limit=limit,
            query_filter=models.Filter(
                must=[models.FieldCondition(key="lesson_id", match=models.MatchValue(value=lesson_id))]
            ),
            with_payload=True,
        )
        points = result.points
    else:
        points = client.search(
            collection_name=collection,
            query_vector=list(vector),
            limit=limit,
            query_filter=models.Filter(
                must=[models.FieldCondition(key="lesson_id", match=models.MatchValue(value=lesson_id))]
            ),
            with_payload=True,
        )

    hits: list[dict[str, Any]] = []
    for point in points:
        payload = point.payload or {}
        hits.append(
            {
                "chunk_id": payload.get("chunk_id") or str(point.id),
                "text": payload.get("text") or "",
                "start_ms": int(payload.get("start_ms") or 0),
                "end_ms": int(payload.get("end_ms") or 0),
                "score": float(getattr(point, "score", 0.0) or 0.0),
            }
        )
    return hits
