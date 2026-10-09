"""Ollama embeddings and Qdrant search, isolated behind a small API."""
from typing import Any
import httpx
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from qdrant_client import QdrantClient
from .config import settings

COLLECTION = 'courseforge_chunks'


def embed_texts(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    with httpx.Client(timeout=180) as http:
        response = http.post(settings.ollama_url + '/api/embed', json={'model': settings.embed_model, 'input': texts})
        response.raise_for_status()
        vectors = response.json()['embeddings']
    if len(vectors) != len(texts) or not vectors or not vectors[0]:
        raise RuntimeError('Ollama returned invalid embedding dimensions')
    return vectors


def client() -> 'QdrantClient':
    from qdrant_client import QdrantClient
    return QdrantClient(url=settings.qdrant_url, timeout=30)


def ensure_collection(qdrant: 'QdrantClient', dimension: int) -> None:
    from qdrant_client import models
    if not qdrant.collection_exists(COLLECTION):
        qdrant.create_collection(collection_name=COLLECTION,
                                 vectors_config=models.VectorParams(size=dimension, distance=models.Distance.COSINE))
    else:
        config = qdrant.get_collection(COLLECTION).config.params.vectors
        if getattr(config, 'size', None) != dimension:
            raise RuntimeError('Embedding dimension mismatch: existing Qdrant collection was built with another model. '
                               'See README: rebuilding the vector collection.')


def index_video(video: dict, chunks: list[dict]) -> None:
    from qdrant_client import models
    contents = [c for c in chunks if c['text'].strip()]
    qdrant = client()
    # On a video with no speech or OCR, keep it in the library with no searchable points.
    if not contents:
        if qdrant.collection_exists(COLLECTION):
            delete_video_points(qdrant, video['id'])
        return
    first = embed_texts([contents[0]['text']])[0]
    ensure_collection(qdrant, len(first))
    # Old points are removed before upserting new ones; failures keep the job retryable.
    delete_video_points(qdrant, video['id'])
    for offset in range(0, len(contents), 8):
        batch = contents[offset:offset + 8]
        vectors = ([first] if offset == 0 else [])
        to_embed = batch[1:] if offset == 0 else batch
        if to_embed:
            vectors.extend(embed_texts([c['text'] for c in to_embed]))
        points = []
        for item, vector in zip(batch, vectors):
            payload = {'video_id': video['id'], 'title': video['title'], 'course': video['course'],
                       'kind': item['kind'], 'start': item['start'], 'end': item['end'],
                       'text': item['text'], 'chunk_id': item['id'], 'frame_path': item['frame_path']}
            points.append(models.PointStruct(id=item['id'], vector=vector, payload=payload))
        qdrant.upsert(collection_name=COLLECTION, points=points, wait=True)


def delete_video_points(qdrant: 'QdrantClient', video_id: str) -> None:
    from qdrant_client import models
    qdrant.delete(collection_name=COLLECTION, points_selector=models.FilterSelector(
        filter=models.Filter(must=[models.FieldCondition(key='video_id', match=models.MatchValue(value=video_id))])
    ), wait=True)


def semantic_search(question: str, course: str | None = None,
                    video_id: str | None = None, limit: int = 8) -> list[dict[str, Any]]:
    from qdrant_client import models
    qdrant = client()
    if not qdrant.collection_exists(COLLECTION):
        return []
    conditions = []
    if course:
        conditions.append(models.FieldCondition(key='course', match=models.MatchValue(value=course)))
    if video_id:
        conditions.append(models.FieldCondition(key='video_id', match=models.MatchValue(value=video_id)))
    vector = embed_texts([question])[0]
    matches = qdrant.query_points(collection_name=COLLECTION, query=vector,
                                  query_filter=models.Filter(must=conditions) if conditions else None,
                                  limit=limit, with_payload=True).points
    return [{**(hit.payload or {}), 'score': round(float(hit.score), 4)} for hit in matches]
