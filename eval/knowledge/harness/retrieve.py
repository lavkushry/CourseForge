"""In-memory hybrid retrieval over the synthetic corpus (no Qdrant / models)."""

from __future__ import annotations

import math
import re

import harness  # noqa: F401 — ensures knowledge_worker is on sys.path
from harness.corpus import Corpus, CorpusChunk
from knowledge_worker.embedder import HashEmbedder, cosine
from knowledge_worker.reranker import LexicalReranker
from knowledge_worker.retrieve import RankedHit, grade_support, hybrid_retrieve

_TOKEN = re.compile(r"[a-z0-9]+", re.I)


def _tokens(text: str) -> list[str]:
    return _TOKEN.findall(text.lower())


def _bm25_rank(query: str, chunks: list[CorpusChunk], limit: int) -> list[RankedHit]:
    """Lightweight BM25-ish ranking (Okapi-style with k1=1.2, b=0.75)."""
    q_terms = _tokens(query)
    if not q_terms or not chunks:
        return []
    docs = [_tokens(c.text) for c in chunks]
    avgdl = sum(len(d) for d in docs) / len(docs)
    df: dict[str, int] = {}
    for d in docs:
        for term in set(d):
            df[term] = df.get(term, 0) + 1
    n = len(docs)
    k1, b = 1.2, 0.75
    scored: list[tuple[float, CorpusChunk]] = []
    for chunk, doc in zip(chunks, docs):
        if not doc:
            continue
        tf: dict[str, int] = {}
        for t in doc:
            tf[t] = tf.get(t, 0) + 1
        score = 0.0
        for term in q_terms:
            if term not in tf:
                continue
            idf = math.log(1.0 + (n - df.get(term, 0) + 0.5) / (df.get(term, 0) + 0.5))
            denom = tf[term] + k1 * (1 - b + b * len(doc) / avgdl)
            score += idf * (tf[term] * (k1 + 1)) / denom
        if score > 0:
            scored.append((score, chunk))
    scored.sort(key=lambda item: (-item[0], item[1].start_ms, item[1].chunk_id))
    return [
        RankedHit(c.chunk_id, c.text, c.start_ms, c.end_ms, score)
        for score, c in scored[:limit]
    ]


def _dense_rank(
    query: str,
    chunks: list[CorpusChunk],
    embedder: HashEmbedder,
    limit: int,
) -> list[RankedHit]:
    if not chunks:
        return []
    q_vec = embedder.embed([query])[0]
    texts = [c.text for c in chunks]
    vectors = embedder.embed(texts)
    scored = [
        (cosine(q_vec, vec), chunk)
        for chunk, vec in zip(chunks, vectors)
    ]
    scored.sort(key=lambda item: (-item[0], item[1].start_ms, item[1].chunk_id))
    return [
        RankedHit(c.chunk_id, c.text, c.start_ms, c.end_ms, score)
        for score, c in scored[:limit]
        if score > 0
    ]


class FixtureRetriever:
    """Hybrid retrieve against a frozen corpus using hash embeddings + lexical rerank."""

    def __init__(self, corpus: Corpus) -> None:
        self.corpus = corpus
        self.embedder = HashEmbedder(dim=corpus.embed_dim)
        self.reranker = LexicalReranker()

    def search(self, video_id: str, query: str, limit: int = 10) -> list[RankedHit]:
        chunks = self.corpus.for_video(video_id)
        bm25 = _bm25_rank(query, chunks, limit=limit)
        dense = _dense_rank(query, chunks, self.embedder, limit=limit)
        return hybrid_retrieve(
            query,
            bm25=bm25,
            dense=dense,
            reranker=self.reranker,
            top_k=limit,
        )

    def supported(self, hits: list[RankedHit], *, min_score: float = 0.05) -> bool:
        return grade_support(hits, min_score=min_score)
