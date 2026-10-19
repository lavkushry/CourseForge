# Living Video Knowledge

Timestamp-grounded Q&A over course videos: ingest (ASR/OCR/chapters), hybrid
retrieval, cited answers with abstention, and a learning layer (concepts, pause
& recall, FSRS flashcards, confusion hotspots).

## Architecture

```text
Browser (web/src/knowledge)
    │  Ask / chapters / recall / review / hotspots
    ▼
Go API (backend/internal/knowledge) ── PostgreSQL (migrations 030–033)
    │                                      │
    │ hybrid BM25 + dense                  │ knowledge_* tables
    ▼                                      │
Qdrant collection: courseforge_knowledge ◄─┘
    ▲
    │ index vectors (never other collections)
Python worker (services/knowledge-worker)
    ASR → scenes/OCR → chapters → chunks → embeddings → spatial candidates
```

| Layer | Path | Role |
| --- | --- | --- |
| API + storage | `backend/internal/knowledge` | Jobs, artifacts, Ask, learning endpoints; wired in `cmd/api/routes.go` |
| Worker | `services/knowledge-worker` | Ingest + indexing; own Dockerfile/requirements; arm64 CPU |
| Player UI | `web/src/knowledge` | Side panel using LMS tokens (`#E54503` accent, dark canvas) |
| Eval | `eval/knowledge` | Gold set, metrics harness, CI thresholds |

**Qdrant:** compose publishes `127.0.0.1:6333` (`qdrant/qdrant:v1.15.5`). Living Video
Knowledge uses only `courseforge_knowledge`. Do not write to `courseforge_chunks`
or any other collection.

**Embedders:** production default is Ollama (`EMBED_MODEL`, same as Go `internal/ai`).
`hash` is an explicit offline/test fallback (`CF_KNOWLEDGE_EMBEDDER=hash`), never a
silent substitute. Index and query embedder names must match.

**Ask path:** hybrid retrieve (BM25 ∪ dense → RRF → rerank) → support gate →
generate with timestamp citations, or abstain with `not covered in this video`.

## Ops

| Variable | Purpose |
| --- | --- |
| `CF_QDRANT_URL` | Qdrant base URL (default `http://127.0.0.1:6333`) |
| `CF_QDRANT_COLLECTION` | Must resolve to `courseforge_knowledge` |
| `CF_KNOWLEDGE_EMBEDDER` | `ollama` (default) or `hash` (tests) |
| `CF_KNOWLEDGE_ENABLE_QDRANT` | Worker: enable vector upserts |
| `CF_KNOWLEDGE_API_URL` / `CF_KNOWLEDGE_WORKER_TOKEN` | Worker ↔ Go job lease API |
| `CF_WHISPER_*` / `CF_OCR_ENGINE` | Ingest engines (CPU; no GPU required) |

Worker image: `services/knowledge-worker/Dockerfile` (linux/arm64 and amd64).
Do not mix worker code into the Go module. Keep Odysee credentials out of browser
responses and logs. Learner isolation and playback ownership stay on the Go API.

Migrations are additive only (`030_knowledge.sql`, `031_knowledge_retrieval.sql`,
`032_knowledge_learning.sql`, `033_knowledge_spatial.sql`). After chapters and
chunks are stored, the worker ranks spatial-view candidates from those
artifacts (OCR, optional vision captions, concept graph, transcript). It does
not render 3D or AR/VR assets. A missing signal is scored as zero and cannot
fail the job. Read them with `GET /api/v1/knowledge/lessons/{id}/spatial-candidates`
or, offline, `python -m knowledge_worker.spatial score bundle.json`.
Career/remediation consumers use the bridge
documented in `backend/internal/knowledge/CAREER_BRIDGE.md` — do not query
`knowledge_*` tables from outside the package.

## Evaluation metrics

Gold format (`eval/knowledge/gold/*.jsonl`):

| Field | Meaning |
| --- | --- |
| `question` | Learner question |
| `video_id` | Target video / lesson fixture id |
| `expected_timestamps_ms` | Gold citation times (ms) |
| `answerable` | Whether the video supports an answer |
| `relevant_chunk_ids` | (optional) chunks that count as retrieval hits |
| `gold_claims` | (optional) claims used when authoring faithfulness fixtures |

Synthetic corpus: `eval/knowledge/fixtures/corpus.json`. Thresholds:
`eval/knowledge/thresholds.yaml`.

| Metric | Definition |
| --- | --- |
| Recall@k (k=1,3,5,10) | Share of answerable questions with a relevant chunk in top-k |
| MRR | Mean reciprocal rank of first relevant chunk |
| Citation accuracy | Cited `[m:ss]` within `citation_tolerance_ms` of a gold timestamp |
| Faithfulness | RAGAS-style claim support via `FaithfulnessJudge`; CI uses lexical fallback |
| Abstention precision | Among abstentions, share that were unanswerable |
| Abstention recall | Among unanswerable, share that abstained |

### Run locally

```bash
cd eval/knowledge
python -m pip install -r requirements.txt
PYTHONPATH=. python -m harness
# or
PYTHONPATH=. pytest -q
```

CI job `knowledge-eval` in `.github/workflows/ci.yml` runs the harness on fixtures
and fails if any metric is below `thresholds.yaml`. No Docker, no large model
downloads; retrieval uses the hash embedder and lexical reranker/judge.

### Metrics table (synthetic fixtures)

From `PYTHONPATH=. python -m harness` against the checked-in gold set:

```text
Living Video Knowledge — evaluation metrics
examples=10 answerable=7 unanswerable=3

metric                      value  threshold   pass
----------------------------------------------------
recall_at_1                 1.000      0.700     ok
recall_at_3                 1.000      0.850     ok
recall_at_5                 1.000      0.900     ok
recall_at_10                1.000      0.900     ok
mrr                         1.000      0.750     ok
citation_accuracy           1.000      0.800     ok
faithfulness                1.000      0.750     ok
abstention_precision        1.000      0.900     ok
abstention_recall           1.000      0.900     ok
```

Offline CI uses hash embeddings, lexical rerank, and a lexical faithfulness judge
(support floor 0.08 to ignore stopword-only Jaccard). Plug in a model judge by
implementing `FaithfulnessJudge` without changing metric definitions.
