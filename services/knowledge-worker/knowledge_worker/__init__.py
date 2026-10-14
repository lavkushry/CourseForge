"""Living Video Knowledge worker (ingest + retrieval indexing)."""

__version__ = "0.2.0"

# Dedicated Qdrant collection; never write to courseforge_chunks.
QDRANT_COLLECTION = "courseforge_knowledge"
