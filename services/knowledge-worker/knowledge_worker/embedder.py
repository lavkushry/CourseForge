"""Pluggable text embedders for Living Video Knowledge.

Default production path: Ollama HTTP embeddings using EMBED_MODEL
(same model as Go internal/ai). HashEmbedder is an explicitly labeled
offline/test fallback — never a silent substitute for Ollama.
"""

from __future__ import annotations

import hashlib
import math
import os
import re
from typing import Protocol, runtime_checkable
from urllib.request import Request, urlopen
import json

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
    """Deterministic bag-of-tokens hashing embedder (shared algorithm with Go).

    Explicit offline/test fallback only — set CF_KNOWLEDGE_EMBEDDER=hash.
    """

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


class OllamaEmbedder:
    """Ollama /api/embeddings — same EMBED_MODEL used by Go internal/ai."""

    def __init__(
        self,
        model: str | None = None,
        base_url: str | None = None,
        timeout: float = 60.0,
    ) -> None:
        self._model = (model or os.environ.get("EMBED_MODEL") or os.environ.get("OLLAMA_EMBED_MODEL") or "qwen3-embedding:0.6b").strip()
        self._base = (base_url or os.environ.get("OLLAMA_URL") or "http://127.0.0.1:11434").rstrip("/")
        self._timeout = timeout
        self._dim = 0
        self.name = f"ollama:{self._model}"

    def dimension(self) -> int:
        return self._dim

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        out: list[list[float]] = []
        for text in texts:
            vec = self._one(text)
            out.append(vec)
            if self._dim == 0 and vec:
                self._dim = len(vec)
        return out

    def _one(self, text: str) -> list[float]:
        payload = json.dumps({"model": self._model, "prompt": text}).encode("utf-8")
        req = Request(
            f"{self._base}/api/embeddings",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(req, timeout=self._timeout) as resp:  # noqa: S310 — configured Ollama URL
            body = json.loads(resp.read().decode("utf-8"))
        emb = body.get("embedding") or []
        return [float(x) for x in emb]


class SentenceTransformerEmbedder:
    """Optional local ST model. Not the default; keep for explicit opt-in."""

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


def build_embedder(kind: str = "ollama", dim: int = 384) -> Embedder:
    """Build embedder. Default is Ollama (EMBED_MODEL). Hash only when kind is hash/mock/offline."""
    kind = (kind or "ollama").strip().lower()
    if kind in {"hash", "mock", "offline"}:
        return HashEmbedder(dim=dim)
    if kind in {"sentence-transformers", "st", "minilm"}:
        return SentenceTransformerEmbedder()
    if kind in {"ollama", "embed", "default", ""}:
        return OllamaEmbedder()
    # Unknown kinds must not silently become hash (that mixes embedders).
    raise ValueError(f"unknown embedder kind {kind!r}; use ollama|hash|sentence-transformers")
