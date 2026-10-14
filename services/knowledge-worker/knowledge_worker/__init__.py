"""Living Video Knowledge ingest worker (ASR, scenes, OCR)."""

__version__ = "0.1.0"

# Dedicated Qdrant collection; never write to courseforge_chunks.
QDRANT_COLLECTION = "courseforge_living_video"
