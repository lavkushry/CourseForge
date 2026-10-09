# CourseForge Local v2 — Implementation design and QA

## Scope

v2 extends the original local media-ingestion/RAG MVP in five independent areas: screen understanding, topic planning, progress, spaced repetition, and verified lab execution. The existing queue/search/source links remain unchanged. This document describes the **implemented** v2 endpoints and their current constraints.

## Components and interfaces

| Module | Responsibility | Persistence |
|---|---|---|
| `app/vision.py` | Bound local Ollama vision calls with screenshot base64 messages | Vision captions appended to `screen` chunks; same SQLite and Qdrant indexes |
| `app/syllabus.py` | Extract bounded lecture topics using Ollama JSON; merge repeated topics; link to video timestamps | SQLite `syllabi` |
| `app/study.py` | Lecture progress, SM-2 review scheduling, question/answer persistence | SQLite `video_progress`, `review_cards`, `review_attempts` |
| `app/reviews.py` | RAG-grounded Q/A card generation with source assignment | `review_cards` via `study.py` |
| `app/labs.py` | Curated lab catalog, per-session file editing, restricted Docker grading, optional kind validation | SQLite `lab_sessions` + file workspaces |
| `app/lab_graders/grade.py` | Only trusted grading code executed inside `courseforge-lab:local` container | Test JSON returned to API |
| `scripts/kind_lab.py` | Opt-in isolated kind cluster create/destroy, independent kubeconfig with provenance | `DATA_DIR/labs/kind-*` |
| `scripts/e2e_real.py` | Real local inference and vector DB smoke test | Original index DB and new cards/syllabus |

## Processing data flow

```
existing videos → SQLite persistent import queue → worker
  ├─ ffprobe duration
  ├─ Whisper timestamps + JSON cache
  └─ FFmpeg periodic changed screenshots
      ├─ Tesseract OCR
      └─ Gemma 3 vision local /api/chat (bounded per lecture)
  ↓
time-aware speech + image-caption chunks
  ├─ SQLite chunks/FTS5
  └─ Ollama embeddings → Qdrant vector index
        ↓
 source-grounded tutor and evidence retrieval
        ├─ topic planning → syllabus + merged sources
        ├─ flashcards → SM-2 schedule
        └─ curated lab selection → isolated grader
```

Visual LLM failures fall back to raw OCR unless `VISION_REQUIRED=1`. Enrichment never executes code read from frames. Timestamps on screenshot samples are approximate.

## Syllabus de-duplication design

The builder reads up to eight evenly distributed excerpts from each completed lecture in one course. The LLM outputs short topic names, objectives and excerpt indices. Matching happens in two stages: canonical token normalization / Jaccard overlap and optional Qdrant-compatible Ollama text embeddings with cosine threshold 0.90. A topic cluster retains **every matched source** and chooses the first as its primary source. JSON and a video-index fingerprint are saved in `syllabi`.

Limitations: topic similarity is heuristic and may under-merge synonyms or over-merge closely related but different concepts. A learner can rebuild after ingesting new videos. No manual reordering or prerequisite graph editing is present yet.

## Spaced repetition and progress

Playback progress is saved via the browser after meaningful time movement and on completion. The next library click resumes saved playback, but citation clicks take precedence over playback position. The `video_progress` table stores `percent`, `position`, `completed`, `updated_at` by `video_id`.

Flashcards carry `course`, `video_id`, timestamp, question, answer and mutable SM-2 state: `repetitions`, `interval_days`, `ease`, `due_at`. Scheduling uses quality 0–5, with quality below 3 resetting repetitions, new passing cards due in one day, second passing review due in six days, and later intervals scaled by easiness. Review attempts are append-only for historical analysis. The UI exposes 0, 3, 4 and 5 grades with answer revealed first. It is self-rating, not semantic response grading.

## Labs trust boundary

```
Browser solution (limited to 100 KB; session-specific file)
         ↓ PUT /api/lab-sessions/{id}/file
SQLite lab session + isolated workspace
         ↓ POST /api/lab-sessions/{id}/submit
Trusted backend builds fixed docker argument list (never shell=True)
         ↓
Docker container (--network none, --read-only, --cap-drop ALL,
 --security-opt no-new-privileges, --pids-limit 64,
 --memory 256m, --cpus 1, --user nobody,
 --tmpfs /tmp, readonly volume mounts, 40 second outer timeout)
         ↓
Curated `grade.py` only. Per-check JSON result → SQLite → UI
```

No Docker socket, host root, production kubeconfig, host SSH keys, cloud tokens or writable host mount is attached. These safeguards reduce the attack surface but cannot guarantee total isolation from a hostile local user or a container engine vulnerability. Do not run it as a shared public grader.

The lab evaluator is intentionally **not** a generic AI command executor. To add new labs, developers add reviewed templates, expected outputs and test fixtures to `LABS` and `grade.py`. The model can help draft a proposed lab in `app/tutor.py`, but no AI-produced code is run without user work and a trusted grader.

### Kubernetes grading tiers

- Tier 1: offline YAML static checks inside Docker with PyYAML, semantic assertions and safe resource-type gating.
- Tier 2 (optional): **server-side dry-run** against a project-provisioned kind cluster; no applied object is retained.

The kind script refuses to adopt a cluster with the fixed lab name when the cluster already exists; it creates an independent kubeconfig/ownership marker and verifies both before destructive cleanup. The API enforces a matching context and a loopback HTTPS Kubernetes endpoint. Default kubeconfig and user-supplied contexts are not used.

## New REST endpoints

| Verb | Path | Purpose |
|---|---|---|
| GET | `/api/progress?course=` | Video watch/complete state |
| PUT | `/api/videos/{id}/progress` | Save percent and position |
| GET | `/api/syllabus?course=` | Read saved course plan |
| POST | `/api/syllabus/generate` | Build / rebuild course plan |
| POST | `/api/reviews/generate` | Generate source-linked cards on one course/topic |
| GET | `/api/reviews/due?course=` | Due flashcards |
| POST | `/api/reviews/{id}/grade` | Self-rate answer, update SM-2 |
| GET | `/api/labs` | Curated lab catalog |
| POST | `/api/labs/{slug}/start` | Create isolated lab session and starter file |
| GET | `/api/lab-sessions/{id}` | Read starter/current answer and saved result |
| PUT | `/api/lab-sessions/{id}/file` | Update editable solution safely |
| POST | `/api/lab-sessions/{id}/submit` | Save test results from Docker and optional kind |

The existing `/api/scan`, `/api/videos`, `/api/jobs`, `/api/search`, `/api/ask`, `/api/videos/{id}/stream`, source frames and reindex routes are retained. All endpoints are localhost-only deployments by convention; FastAPI also rejects cross-origin mutations and unknown Host headers. It is still **not** a full authentication scheme.

## SQL compatibility and migrations

`init_db()` runs idempotent `CREATE TABLE IF NOT EXISTS` statements for the new tables after the original schema. Original videos, jobs, chunks, search references and FTS5 data are not deleted. For future team deployments, replace these startup schema changes with versioned SQL migrations and transaction-safe rollout procedures.

## Test matrix

| Test group | Real dependencies | What is verified |
|---|---|---|
| `pytest` on local dev/CI | Python + FFmpeg/Tesseract (media test) | chunking, state, API, queue, vision failure budget, topic dedup, SM-2, lab I/O and trusted grader fixtures |
| `node --check` | Node.js | UI JavaScript syntax |
| `python scripts/doctor.py` | Host Ollama, Qdrant, Docker | dependency and installed model diagnostics |
| `python scripts/e2e_real.py --video-id ID` | Complete real local services + one lecture | real transcription, frames, vision, embeddings/index, tutor, syllabus and flashcards |
| Manually click graded lab | Docker lab image | sandbox container invocation, hidden tests and UI result rendering |
| Opt-in kind validation | kind/kubectl | isolated server-side YAML dry-run |

Do **not** claim that real model inference or Docker execution succeeded based on mocked unit/integration tests alone. Report the outcome of the real-device smoke test independently after running it.

## Production-hardening backlog (outside v2 prototype)

- AuthN/AuthZ and per-user course/course-card ownership, CSRF/rate-limit controls, TLS reverse proxy.
- Signed source timestamps, source-level review of vision hallucinations and strict quote validation.
- Job scheduler locks for multiple workers, index-generation atomic swap and robust rollback of embedding failures.
- Human-editable syllabus and prerequisites, duplicate-resolution feedback, topic-level competency metrics.
- Isolated microVM/container runtime with separate privileges and explicit offline image pinning/digest verification for untrusted public submissions.
- Docker/Kubernetes tests in real CI runners with Docker installed, plus platform-specific Mac integration tests.
- Offline subtitle ingestion, resumable large-video processing, native playback transcoding.
