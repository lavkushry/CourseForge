"""Qdrant helpers for the dedicated Living Video collection only."""

from __future__ import annotations

import logging
from typing import Any

from knowledge_worker import QDRANT_COLLECTION

log = logging.getLogger(__name__)


def ensure_living_video_collection(client: Any, dimension: int, collection: str = QDRANT_COLLECTION) -> None:
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
        # Tests and minimal installs may omit qdrant_client; callers still get a create attempt.
        vectors_config = {"size": dimension, "distance": "Cosine"}
    client.create_collection(collection_name=collection, vectors_config=vectors_config)
    log.info("created qdrant collection %s dim=%s", collection, dimension)
