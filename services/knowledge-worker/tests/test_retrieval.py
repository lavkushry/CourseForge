from knowledge_worker.chaptering import text_tiling_chapters
from knowledge_worker.chunking import build_multimodal_chunks
from knowledge_worker.embedder import HashEmbedder, build_embedder, cosine
from knowledge_worker.index_pipeline import build_index_artifacts
from knowledge_worker.qdrant_store import EmbedderMismatchError, ensure_knowledge_collection
from knowledge_worker.reranker import LexicalReranker
from knowledge_worker.retrieve import (
    RankedHit,
    grade_support,
    hybrid_retrieve,
    reciprocal_rank_fusion,
    retrieve_with_support,
)
from knowledge_worker import QDRANT_COLLECTION


def _segments() -> list[dict]:
    # Two distinct topics so TextTiling can find a boundary.
    topic_a = [
        {"ordinal": i, "start_ms": i * 1000, "end_ms": i * 1000 + 900, "text": text}
        for i, text in enumerate(
            [
                "docker containers package applications with dependencies",
                "images are layered filesystems built from dockerfiles",
                "compose orchestrates multi container local stacks",
            ]
        )
    ]
    topic_b = [
        {
            "ordinal": i + 3,
            "start_ms": (i + 3) * 1000,
            "end_ms": (i + 3) * 1000 + 900,
            "text": text,
        }
        for i, text in enumerate(
            [
                "postgres stores relational tables with sql queries",
                "indexes speed up selective lookups on primary keys",
                "transactions guarantee atomic commits and rollbacks",
            ]
        )
    ]
    return topic_a + topic_b


def test_hash_embedder_normalized_and_stable():
    emb = HashEmbedder(dim=32)
    a = emb.embed(["hello world"])[0]
    b = emb.embed(["hello world"])[0]
    assert a == b
    assert abs(sum(x * x for x in a) - 1.0) < 1e-6
    assert cosine(a, emb.embed(["unrelated quantum topology"])[0]) < cosine(a, emb.embed(["hello there world"])[0])


def test_text_tiling_produces_chapters_with_bounds():
    chapters = text_tiling_chapters(_segments(), HashEmbedder(dim=64), window=1, smooth_radius=0)
    assert len(chapters) >= 1
    assert chapters[0].start_ms == 0
    assert chapters[-1].end_ms == _segments()[-1]["end_ms"]
    for c in chapters:
        assert c.end_ms >= c.start_ms
        assert c.title


def test_multimodal_chunks_merge_ocr():
    segments = [{"ordinal": 0, "start_ms": 0, "end_ms": 2000, "text": "install packages"}]
    keyframes = [
        {
            "ordinal": 0,
            "time_ms": 500,
            "ocr": {"text": "sudo apt update", "tags": ["command"]},
        }
    ]
    chunks = build_multimodal_chunks(segments, keyframes)
    assert len(chunks) == 1
    assert chunks[0].source == "multimodal"
    assert "sudo apt update" in chunks[0].text


def test_rrf_and_hybrid_rerank():
    bm25 = [
        RankedHit("a", "docker compose stacks", 0, 1, 1.0),
        RankedHit("b", "postgres indexes", 2, 3, 0.5),
    ]
    dense = [
        RankedHit("b", "postgres indexes", 2, 3, 0.9),
        RankedHit("c", "kubernetes pods", 4, 5, 0.8),
    ]
    fused = reciprocal_rank_fusion([["a", "b"], ["b", "c"]])
    assert fused[0][0] == "b"
    hits = hybrid_retrieve("postgres index", bm25=bm25, dense=dense, reranker=LexicalReranker(), top_k=2)
    assert hits[0].chunk_id == "b"
    assert grade_support(hits, min_score=0.01)


def test_retrieve_with_support_broadens_then_abstains():
    def search(query: str, limit: int):
        if "quantum" in query.lower():
            return [], []
        # Broadened keyword path still empty for this fixture.
        return [], []

    hits, supported, broadened = retrieve_with_support(
        "what is quantum entanglement",
        search,
        reranker=LexicalReranker(),
        min_score=0.2,
    )
    assert hits == []
    assert supported is False
    assert broadened is True


def test_index_pipeline_with_hash_embedder():
    chapters, chunks, vectors = build_index_artifacts(
        _segments(),
        [{"ordinal": 0, "time_ms": 100, "ocr": {"text": "SELECT 1", "tags": ["code"]}}],
        embedder=HashEmbedder(dim=32),
    )
    assert chapters
    assert chunks
    assert len(vectors) == len(chunks)
    assert len(vectors[0]) == 32


def test_qdrant_collection_is_courseforge_knowledge():
    assert QDRANT_COLLECTION == "courseforge_knowledge"
    assert QDRANT_COLLECTION != "courseforge_chunks"

    class FakeClient:
        def __init__(self) -> None:
            self.created = None
            self.meta = {}

        def collection_exists(self, name: str) -> bool:
            return self.created is not None

        def create_collection(self, collection_name: str, vectors_config, metadata=None) -> None:
            self.created = collection_name
            self.meta = metadata or {}

        def get_collection(self, name: str):
            class Info:
                metadata = self.meta

            return Info()

    client = FakeClient()
    ensure_knowledge_collection(client, dimension=8, embedder="ollama:qwen3-embedding:0.6b")
    assert client.created == "courseforge_knowledge"
    assert client.meta.get("embedder") == "ollama:qwen3-embedding:0.6b"
    try:
        ensure_knowledge_collection(client, dimension=8, collection="courseforge_chunks")
        raise AssertionError("should refuse legacy collection")
    except ValueError:
        pass
    try:
        ensure_knowledge_collection(
            client, dimension=8, embedder="hash"
        )
        raise AssertionError("should refuse embedder mix")
    except EmbedderMismatchError:
        pass


def test_build_embedder_hash_is_explicit_fallback():
    emb = build_embedder("hash", dim=16)
    assert emb.name == "hash"
    assert emb.dimension() == 16
    try:
        build_embedder("not-a-real-embedder")
        raise AssertionError("unknown kind must not silently become hash")
    except ValueError:
        pass
