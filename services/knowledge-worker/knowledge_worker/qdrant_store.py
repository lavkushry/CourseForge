"""Qdrant helpers for the dedicated Living Video Knowledge collection only."""

from __future__ import annotations

import logging
import uuid
from typing import Any, Sequence

from knowledge_worker import QDRANT_COLLECTION

log = logging.getLogger(__name__)


class EmbedderMismatchError(ValueError):
    """Raised when the collection was created with a different embedder/dim."""


def _collection_meta(client: Any, collection: str) -> dict[str, Any]:
    try:
        info = client.get_collection(collection)
    except Exception:
        return {}
    meta: dict[str, Any] = {}
    # qdrant-client versions expose metadata differently; support common shapes.
    raw = getattr(info, "config", None)
    payload_meta = getattr(info, "metadata", None) or getattr(info, "collection_metadata", None)
    if isinstance(payload_meta, dict):
        meta.update(payload_meta)
    if hasattr(info, "dict"):
        try:
            d = info.dict()
            if isinstance(d.get("metadata"), dict):
                meta.update(d["metadata"])
            params = (((d.get("config") or {}).get("params") or {}).get("vectors") or {})
            if isinstance(params, dict) and params.get("size"):
                meta.setdefault("dim", int(params["size"]))
        except Exception:
            pass
    if raw is not None and hasattr(raw, "params"):
        try:
            size = raw.params.vectors.size  # type: ignore[attr-defined]
            meta.setdefault("dim", int(size))
        except Exception:
            pass
    return meta


def ensure_knowledge_collection(
    client: Any,
    dimension: int,
    collection: str = QDRANT_COLLECTION,
    *,
    embedder: str = "",
) -> None:
    """Create the dedicated collection if missing. Never mutate other collections.

    Stores embedder name + dim in collection metadata and refuses to mix embedders.
    """
    if collection != QDRANT_COLLECTION:
        raise ValueError(f"refusing non-dedicated Qdrant collection: {collection}")
    if hasattr(client, "collection_exists"):
        exists = client.collection_exists(collection)
    else:
        names = {c.name for c in client.get_collections().collections}
        exists = collection in names
    if exists:
        meta = _collection_meta(client, collection)
        stored_emb = str(meta.get("embedder") or "")
        stored_dim = int(meta.get("dim") or 0)
        if stored_emb and embedder and stored_emb != embedder:
            raise EmbedderMismatchError(
                f"collection embedder mismatch: stored={stored_emb} requested={embedder}"
            )
        if stored_dim and dimension and stored_dim != dimension:
            raise EmbedderMismatchError(
                f"collection dim mismatch: stored={stored_dim} requested={dimension}"
            )
        return
    try:
        from qdrant_client import models  # type: ignore

        vectors_config = models.VectorParams(size=dimension, distance=models.Distance.COSINE)
    except ImportError:
        vectors_config = {"size": dimension, "distance": "Cosine"}
    create_kwargs: dict[str, Any] = {
        "collection_name": collection,
        "vectors_config": vectors_config,
    }
    # Prefer writing metadata when the client supports it.
    metadata = {"embedder": embedder, "dim": dimension}
    try:
        client.create_collection(**create_kwargs, metadata=metadata)
    except TypeError:
        client.create_collection(**create_kwargs)
        if hasattr(client, "update_collection"):
            try:
                client.update_collection(collection_name=collection, metadata=metadata)
            except Exception:
                log.warning("could not persist collection metadata for %s", collection)
    log.info("created qdrant collection %s dim=%s embedder=%s", collection, dimension, embedder)


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
    embedder: str = "",
    embed_dim: int = 0,
) -> int:
    if collection != QDRANT_COLLECTION:
        raise ValueError(f"refusing non-dedicated Qdrant collection: {collection}")
    if len(chunks) != len(vectors):
        raise ValueError("chunks/vectors length mismatch")
    if not chunks:
        return 0
    dim = embed_dim or (len(vectors[0]) if vectors else 0)
    if embedder:
        meta = _collection_meta(client, collection)
        stored_emb = str(meta.get("embedder") or "")
        stored_dim = int(meta.get("dim") or 0)
        if stored_emb and stored_emb != embedder:
            raise EmbedderMismatchError(
                f"refusing to upsert with embedder {embedder}; collection uses {stored_emb}"
            )
        if stored_dim and dim and stored_dim != dim:
            raise EmbedderMismatchError(
                f"refusing to upsert dim {dim}; collection uses {stored_dim}"
            )
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
        payload = {
            "lesson_id": lesson_id,
            "chunk_id": chunk_id,
            "ordinal": int(chunk["ordinal"]),
            "start_ms": int(chunk["start_ms"]),
            "end_ms": int(chunk["end_ms"]),
            "text": str(chunk["text"]),
            "source": str(chunk.get("source") or "multimodal"),
            "embedder": embedder,
            "embed_dim": dim,
        }
        points.append(
            models.PointStruct(
                id=_point_id(chunk_id),
                vector=list(vector),
                payload=payload,
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
    embedder: str = "",
) -> list[dict[str, Any]]:
    if collection != QDRANT_COLLECTION:
        raise ValueError(f"refusing non-dedicated Qdrant collection: {collection}")
    try:
        from qdrant_client import models  # type: ignore
    except ImportError as exc:
        raise RuntimeError("qdrant_client required for search") from exc

    must = [models.FieldCondition(key="lesson_id", match=models.MatchValue(value=lesson_id))]
    if embedder:
        meta = _collection_meta(client, collection)
        stored_emb = str(meta.get("embedder") or "")
        if stored_emb and stored_emb != embedder:
            raise EmbedderMismatchError(
                f"query embedder {embedder} != collection {stored_emb}"
            )
        must.append(models.FieldCondition(key="embedder", match=models.MatchValue(value=embedder)))

    if hasattr(client, "query_points"):
        result = client.query_points(
            collection_name=collection,
            query=list(vector),
            limit=limit,
            query_filter=models.Filter(must=must),
            with_payload=True,
        )
        points = result.points
    else:
        points = client.search(
            collection_name=collection,
            query_vector=list(vector),
            limit=limit,
            query_filter=models.Filter(must=must),
            with_payload=True,
        )

    hits: list[dict[str, Any]] = []
    for point in points:
        payload = point.payload or {}
        if embedder and payload.get("embedder") and payload.get("embedder") != embedder:
            continue
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
