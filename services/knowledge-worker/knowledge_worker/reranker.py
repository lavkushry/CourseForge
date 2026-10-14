"""Pluggable passage rerankers (cross-encoder default when available)."""

from __future__ import annotations

import re
from typing import Protocol, Sequence, runtime_checkable

_TOKEN = re.compile(r"[a-z0-9]+", re.I)


@runtime_checkable
class Reranker(Protocol):
    name: str

    def rerank(self, query: str, passages: Sequence[str]) -> list[float]: ...


class LexicalReranker:
    """Offline / test reranker using token overlap."""

    name = "lexical"

    def rerank(self, query: str, passages: Sequence[str]) -> list[float]:
        q = set(_TOKEN.findall(query.lower()))
        if not q:
            return [0.0 for _ in passages]
        scores: list[float] = []
        for passage in passages:
            p = set(_TOKEN.findall(passage.lower()))
            if not p:
                scores.append(0.0)
                continue
            scores.append(len(q & p) / len(q | p))
        return scores


class CrossEncoderReranker:
    """sentence-transformers CrossEncoder (lazy import; arm64 CPU)."""

    name = "cross-encoder"

    def __init__(self, model_name: str = "cross-encoder/ms-marco-MiniLM-L-6-v2") -> None:
        from sentence_transformers import CrossEncoder  # type: ignore

        self._model = CrossEncoder(model_name)

    def rerank(self, query: str, passages: Sequence[str]) -> list[float]:
        if not passages:
            return []
        pairs = [(query, p) for p in passages]
        scores = self._model.predict(pairs, show_progress_bar=False)
        return [float(s) for s in scores]


def build_reranker(kind: str = "cross-encoder") -> Reranker:
    kind = (kind or "cross-encoder").strip().lower()
    if kind in {"lexical", "mock"}:
        return LexicalReranker()
    if kind in {"cross-encoder", "ce", "cross_encoder"}:
        try:
            return CrossEncoderReranker()
        except Exception:
            return LexicalReranker()
    return LexicalReranker()
