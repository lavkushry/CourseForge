"""Hybrid BM25 + dense retrieval with reciprocal rank fusion and reranking."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Sequence

from knowledge_worker.reranker import LexicalReranker, Reranker


@dataclass(frozen=True)
class RankedHit:
    chunk_id: str
    text: str
    start_ms: int
    end_ms: int
    score: float


def reciprocal_rank_fusion(
    rankings: Sequence[Sequence[str]],
    *,
    k: int = 60,
) -> list[tuple[str, float]]:
    """Fuse ranked id lists with RRF. Higher score is better."""
    scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, chunk_id in enumerate(ranking, start=1):
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda item: (-item[1], item[0]))


def hybrid_retrieve(
    query: str,
    *,
    bm25: Sequence[RankedHit],
    dense: Sequence[RankedHit],
    reranker: Reranker | None = None,
    top_k: int = 6,
) -> list[RankedHit]:
    """Fuse BM25 and dense rankings, then apply a pluggable reranker."""
    by_id: dict[str, RankedHit] = {}
    for hit in (*bm25, *dense):
        prev = by_id.get(hit.chunk_id)
        if prev is None or hit.score > prev.score:
            by_id[hit.chunk_id] = hit

    fused = reciprocal_rank_fusion(
        [[h.chunk_id for h in bm25], [h.chunk_id for h in dense]],
    )
    candidates = []
    for chunk_id, rrf_score in fused:
        hit = by_id[chunk_id]
        candidates.append(
            RankedHit(
                chunk_id=hit.chunk_id,
                text=hit.text,
                start_ms=hit.start_ms,
                end_ms=hit.end_ms,
                score=rrf_score,
            )
        )

    if not candidates:
        return []

    reranker = reranker or LexicalReranker()
    scores = reranker.rerank(query, [c.text for c in candidates])
    rescored = [
        RankedHit(
            chunk_id=c.chunk_id,
            text=c.text,
            start_ms=c.start_ms,
            end_ms=c.end_ms,
            score=float(scores[i]) if i < len(scores) else c.score,
        )
        for i, c in enumerate(candidates)
    ]
    rescored.sort(key=lambda h: (-h.score, h.start_ms, h.chunk_id))
    return rescored[:top_k]


def grade_support(hits: Sequence[RankedHit], *, min_score: float = 0.05) -> bool:
    """Self-RAG/CRAG-style support gate: require at least one relevant hit."""
    return any(h.score >= min_score for h in hits)


def broaden_query(query: str) -> str:
    """Drop common stopwords once to widen lexical/dense match."""
    stop = {
        "what",
        "is",
        "an",
        "a",
        "the",
        "in",
        "of",
        "for",
        "how",
        "why",
        "does",
        "do",
        "can",
        "to",
        "and",
        "or",
        "with",
        "by",
        "on",
        "at",
        "from",
        "explain",
        "describe",
        "tell",
        "me",
        "about",
    }
    words = [w for w in query.split() if w.lower() not in stop and len(w) > 1]
    return " ".join(words) if words else query


def retrieve_with_support(
    query: str,
    search: Callable[[str, int], tuple[list[RankedHit], list[RankedHit]]],
    *,
    reranker: Reranker | None = None,
    top_k: int = 6,
    min_score: float = 0.05,
) -> tuple[list[RankedHit], bool, bool]:
    """Retrieve, grade support, broaden once on failure.

    Returns (hits, supported, broadened).
    """
    bm25, dense = search(query, top_k)
    hits = hybrid_retrieve(query, bm25=bm25, dense=dense, reranker=reranker, top_k=top_k)
    if grade_support(hits, min_score=min_score):
        return hits, True, False
    widened = broaden_query(query)
    if widened == query:
        return hits, False, False
    bm252, dense2 = search(widened, top_k * 2)
    hits2 = hybrid_retrieve(widened, bm25=bm252, dense=dense2, reranker=reranker, top_k=top_k)
    if grade_support(hits2, min_score=min_score):
        return hits2, True, True
    return hits2, False, True
