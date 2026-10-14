"""Pluggable text embedders for Living Video Knowledge.

Default production path: sentence-transformers (small CPU model).
Tests inject mocks; HashEmbedder is a deterministic offline fallback.
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import Protocol, runtime_checkable

_TOKEN = re.compile(r"[a-z0-9]+", re.I)


@runtime_checkable
class Embedder(Protocol):
    name: str

    def dimension(self) -> int: ...

    def embed(self, texts: list[str]) -> list[list[float]]: ...


def _normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec))
    if norm <= 1e-12:
        return vec
    return [v / norm for v in vec]


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    return sum(x * y for x, y in zip(a, b))


class HashEmbedder:
    """Deterministic bag-of-tokens hashing embedder (shared algorithm with Go)."""

    name = "hash"

    def __init__(self, dim: int = 384) -> None:
        if dim < 8:
            raise ValueError("dimension must be >= 8")
        self._dim = dim

    def dimension(self) -> int:
        return self._dim

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._one(t) for t in texts]

    def _one(self, text: str) -> list[float]:
        vec = [0.0] * self._dim
        for tok in _TOKEN.findall(text.lower()):
            digest = hashlib.sha256(tok.encode("utf-8")).digest()
            idx = int.from_bytes(digest[:4], "little") % self._dim
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vec[idx] += sign
        return _normalize(vec)


class SentenceTransformerEmbedder:
    """Small sentence-transformers model (arm64 CPU). Lazy-imports torch stack."""

    name = "sentence-transformers"

    def __init__(self, model_name: str = "sentence-transformers/all-MiniLM-L6-v2") -> None:
        from sentence_transformers import SentenceTransformer  # type: ignore

        self._model = SentenceTransformer(model_name)
        self._dim = int(self._model.get_sentence_embedding_dimension())
        self._model_name = model_name

    def dimension(self) -> int:
        return self._dim

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        vectors = self._model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
        return [list(map(float, row)) for row in vectors]


def build_embedder(kind: str = "sentence-transformers", dim: int = 384) -> Embedder:
    kind = (kind or "sentence-transformers").strip().lower()
    if kind in {"hash", "mock"}:
        return HashEmbedder(dim=dim)
    if kind in {"sentence-transformers", "st", "minilm"}:
        try:
            return SentenceTransformerEmbedder()
        except Exception:
            return HashEmbedder(dim=dim)
    return HashEmbedder(dim=dim)
