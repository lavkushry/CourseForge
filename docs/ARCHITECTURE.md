# CourseForge Local — Original MVP architecture (v1 baseline)

> **v2 note:** This document describes the original system only. For implemented vision analysis, topic planning, review scheduling, progress, graded Docker labs and optional kind validation, read [V2_IMPLEMENTATION.md](V2_IMPLEMENTATION.md). The v1 "not yet" limitations below are superseded by that document.


## 1. Product vision

A private study workbench that converts a folder of saved training videos into a grounded, searchable, interactive learning resource. The product is not another video viewer: it prioritizes fast concept discovery, references to original lectures, and repeated practical application.

### Problem and desired outcomes

A learner may accumulate tens or hundreds of hours of content across Kubernetes, Terraform, Ansible, Python, SQL, Spark, cloud engineering and other courses. Linear playback repeats fundamentals already known, makes cross-course comparison difficult, hides useful terminal commands, and doesn't measure applied competency.

The platform should let learners obtain accurate relevant material with source evidence, navigate the exact moment in the original video, and practice independently. Course content remains local unless the learner deliberately configures remote endpoints.

### Personas

- **Independent technical learner:** wants deep explanations across saved courses and hands-on labs instead of repeating lectures.
- **Engineer refreshing a skill:** wants commands, syntax, diagnostic workflows and relevant lecture timestamps.
- **Course curator:** wants to add a directory once and see it processed without manual file-by-file upload.

### Business requirements (BRD)

| ID | Requirement | Success criterion |
|---|---|---|
| BR-01 | Learn from existing locally downloaded videos | No cloud media upload; stable original paths |
| BR-02 | Reduce effort locating relevant information | Query returns cited lecture timestamp |
| BR-03 | Convert information into skill | Source-grounded exercise or quiz for a selected topic |
| BR-04 | Avoid losing work on interruptions | Job can resume/retry after process restart |
| BR-05 | Minimize operating cost | Local LLM, transcription, OCR and vector store |
| BR-06 | Preserve learner control | Playback and cited evidence remain independently inspectable |

### Functional requirements (PRD)

- FR-01 Directory scan supports supported video extensions, recursive discovery, file-change detection, course grouping by first-level folder and excludes escaping symlinks.
- FR-02 Persistent queue processes lectures sequentially with retry/reindex. Statuses: queued, processing, done, failed.
- FR-03 ASR emits timestamped transcript segments and time-aware overlapping chunks.
- FR-04 Video visual pipeline samples frames, deduplicates visually similar images, extracts OCR text and retains the frame for validation.
- FR-05 Index joins vectors and transcripts by immutable source IDs. Metadata contains video, course, kind, time boundaries and original content.
- FR-06 Hybrid retrieval combines vector matches with local full-text search, filters by video or course and deduplicates.
- FR-07 Tutor offers explanation, notes, quiz and practical lab modes with citations. Abstains if sources are missing.
- FR-08 Clickable evidence opens lecture video at the corresponding timestamp; user can inspect the original frame/lecture.
- FR-09 Local first: services bound to loopback, no automatic execution of generated terminal commands.

### Nonfunctional requirements

- NFR-01 Transcripts/screenshots survive API restarts. Worker jobs survive worker crashes; a restart retries interrupted jobs.
- NFR-02 Every sourced answer includes clear source references and the UI must display excerpts as evidence. Model claims need human verification.
- NFR-03 The prototype must be auditable and understandable. Python code is modular with explicit external dependencies.
- NFR-04 OCR mistakes must never silently become executable automation.
- NFR-05 No third-party SaaS or API tokens required for running the demo.

## 2. System components and responsibilities

| Component | Responsibilities | Storage |
|---|---|---|
| `app/main.py` | FastAPI REST APIs, validation, source video and frame serving | Reads SQLite |
| `app/library.py` | Recursive folder discovery, change detection, queueing | SQLite |
| `app/db.py` | WAL-backed metadata, FTS5, persistent job state | SQLite |
| `app/worker.py` | Single-process durable job consumer and lifecycle | SQLite |
| `app/extractor.py` | ASR, FFprobe duration, FFmpeg screenshots, OCR | JSON + JPEG files |
| `app/chunking.py` | Time-aware overlapping chunks and identifiers | Transient |
| `app/vectorstore.py` | Ollama embedding calls, Qdrant collection/index/query | Qdrant volume |
| `app/tutor.py` | Retrieval and constrained instructor/lab prompts | Local Ollama |
| `app/static` | Source explorer and minimal learning dashboard | Browser memory only |

### Data stores

SQLite `videos`: ID, source path, course, title, size, mtime nanoseconds, status, duration, language, error, indexed timestamp. Stable `id` is derived from absolute source path. A renamed/moved video currently becomes a new source; garbage collection for stale files is future work.

SQLite `jobs`: job ID, video ID, status, stage, attempt, timestamps. Worker uses `BEGIN IMMEDIATE` to claim one queued job; restart returns interrupted jobs to queue. **Exactly one worker is assumed**: two workers recovering `processing` jobs could race.

SQLite `chunks`: chunk ID, video ID, kind (`speech` or `screen`), start/end offsets, text, optional relative frame path. The `chunk_fts` virtual table indexes searchable text. Transcript source chunks and OCR screen chunks are both represented uniformly.

Qdrant `courseforge_chunks`: cosine dense vectors and payload `video_id, title, course, kind, start, end, text, chunk_id, frame_path`. Empty-OCR screenshot chunks remain in SQLite but are not vectorized.

### Processing state machine

```text
new/changed file
     |
     v
  QUEUED ---> PROCESSING ----> DONE
                  |
                  +----------> FAILED
                                 |
                           user reindex
                                 |
                              QUEUED
```

Worker stages: `Probing video` → `Transcribing audio` → `Extracting slides and OCR` → `Embedding chunks` → index upsert → SQLite chunk replace → mark done. A failure marks the job failed; previous vector/index state may be partially updated if failure occurs mid-index. The user can reindex. A production implementation would stage vectors in a new index generation and atomically switch active index generation after a successful commit.

## 3. Core APIs

| Method | Route | Behavior |
|---|---|---|
| GET | `/api/health` | Local app configuration check |
| POST | `/api/scan` | Scan source root and queue new/changed lectures |
| GET | `/api/videos` | List courses/videos/status |
| GET | `/api/jobs` | Last 150 job records |
| GET | `/api/videos/{id}` | Video and indexed timeline |
| POST | `/api/videos/{id}/reindex` | Retry or reprocess lecture |
| GET | `/api/videos/{id}/stream` | Range-capable original video response |
| GET | `/api/chunks/{id}/frame` | Source screenshot, path constrained to data dir |
| GET | `/api/search?q=...&course=...` | Ranked hybrid excerpts |
| POST | `/api/ask` | Grounded answer, notes, quiz or lab + references |

`POST /api/ask` body:

```json
{
  "question": "Teach me why a Kubernetes Service needs endpoints",
  "mode": "explain",
  "course": "Kubernetes",
  "video_id": null
}
```

Response shape:

```json
{
  "answer": "... see [S1] ...",
  "sources": [
    {"label":"S1", "title":"02 networking", "course":"Kubernetes",
     "video_id":"<stable id>", "kind":"speech", "start":78.0,
     "end":99.0, "text":"...", "score":0.77,
     "chunk_id":"<stable id>", "frame_path":null}
  ]
}
```

## 4. Retrieval and quality

1. Embed the query with the same Ollama embedding model used at index time.
2. Query Qdrant cosine similarity, optionally filtering by course and video.
3. Query SQLite FTS5; merge and deduplicate by chunk ID.
4. Build a bounded evidence block with source IDs `[S1] ...` and video offsets.
5. Ask Ollama to teach exclusively from source facts, and clearly mark examples not directly documented.
6. Return answer and source records. Click a source to seek to the corresponding lecture time.

The current heuristic mixes dense hits first and keyword hits next; this is **not** reciprocal-rank fusion or a trained reranker. For quality at scale, upgrade to a real hybrid rank fusion + code-aware reranking model; use recall@k and grounded-answer evaluation. Generic LLM references should be treated as unverified until checked against the source records.

### Sample evaluation set

- Ask for an exact command shown on a screenshot and inspect OCR accuracy against frame image.
- Ask a concept that exists only in one course and assert the cited `video_id` and time range match.
- Ask out-of-domain questions and expect an abstention/no-evidence statement.
- Ask malicious instructions embedded in a lecture transcript; test that the assistant treats source material as data.
- Test recovery after worker killed mid-transcription/indexing and after modifying a source video.
- Test Mac/Chrome/Safari MP4 playback; handle MKV codecs separately.

## 5. Hands-on lab specification

For each requested concept, the lab generator should return:

1. **Objective and prerequisites**: concept to practice, required local tooling, rough difficulty.
2. **Sandbox and setup**: disposable environment such as Docker, kind/k3d, local Python virtual environment, local Spark, or temporary database.
3. **Practical exercises**: tasks, input fixtures, commands where evidenced, expected outputs and validation steps.
4. **Hints and answer key**: incrementally reveal approaches and common failure modes.
5. **Cleanup and self-check**: demonstrate validation and return environment to baseline.

The **MVP generates labs as text only**. Future work can store `lab_runs` and test answers. Never auto-run LLM-written shell scripts, Ansible playbooks, SQL migrations or cloud actions on the host or production credentials.

## 6. Threat model and safeguards

| Threat | MVP mitigation | Remaining risk |
|---|---|---|
| Video/HTML content escapes library root | Canonical paths + root containment checks | Symlink and underlying file may change between scan and read |
| Cross-site scripting in OCR/AI answer | Browser text nodes and `pre.textContent`, no unsafe Markdown injection | Future rich Markdown renderer must sanitize HTML |
| Malicious prompt embedded in transcript | Clear source-as-data system instruction | Prompt injection cannot be fully eliminated by prompting alone |
| Generated dangerous commands | Output only; no auto-execution | A user can still manually run unsafe commands |
| Unauthorized network access | API/Qdrant on localhost, no SaaS required | No authentication if port exposed by user |
| Confidential screenshots/transcripts | All stores are local | Disk/filesystem backup and malware exposure |
| Inconsistent Qdrant/SQLite state | Reindex and persistent queue | No atomic cross-store commit; improve with generation switch |

## 7. Evolution roadmap

### Phase 1 — delivered scaffold

Directory scan, resilient sequential import, speech transcription, sampled screenshots/OCR, time-aware chunks, local embeddings/search, tutor/notes/quizzes/labs, original video evidence/player and unit tests.

### Phase 2 — multimodal accuracy and faster retrieval

- Use scene-boundary/change-point detection and exact PTS timestamps instead of fixed-interval frames.
- Add local vision-language model to describe diagrams/charts and verify screenshot code text.
- Code-aware OCR grouping, AST/language detection, snippets with exact timestamps and downloadable notes.
- Batch embeddings with retries/backoff, quantization, vector payload indexes and reciprocal-rank fusion.
- Filesystem reconciliation and index generations to eliminate orphaned or partially written points.

### Phase 3 — guided learning

- Lesson-level syllabus, knowledge graph and dependency graph across multiple courses.
- Knowledge-gap detection through diagnostic quizzes; spaced repetition and flashcards.
- Learning progress, goals, daily review plans and checkpoint-based capstones.
- Lab runner restricted to disposable containers, predeclared allowlists and no host credentials; explicit approval before any execution.
- PDF/slides/notebooks ingestion with line/page metadata and hybrid source citations.

### Phase 4 — shareable engineering platform

- Authentication, per-user stores and authorization, audit logs and configurable media access.
- Redis Streams/RabbitMQ queues, job leases, bounded parallel workers, retry/DLQ, cancellation and back-pressure.
- Metrics (Prometheus), OpenTelemetry traces, structured logging, dashboard and alerts.
- Helm/Kubernetes deployment option with encrypted storage, resource limits and model management.
- Backup/restore, migrations, corruption checks and predictable disk-space budget.

## 8. Performance and delivery acceptance

Functional acceptance for local demo:

1. Put two videos under two course directories; one scan should create exactly two queue entries.
2. Start one worker; it should mark done only after transcript, optional screenshots and vector indexing finish.
3. Ask a question answerable by a clip; response must show at least one video/time source and clicking must seek near the original explanation.
4. Ask for a lab; output contains tasks and verification commands but executes nothing.
5. Kill the worker and restart; an interrupted job is recovered and finished on retry.
6. Re-run scan against unchanged inputs: no duplicate jobs; after a file changes: one new job after previous active job finishes.
7. Verify no upload of original media to remote providers (watch network traffic if handling sensitive material).
8. Confirm screenshots and transcriptions are reviewed for OCR/ASR errors, including code punctuation.

Aspirational performance after tuning (not yet benchmarked): sub-second local metadata and keyword search; low-seconds vector retrieval for moderate collections; tutor answer latency dominated by model prefill/generation; batch throughput measured as processing-minutes per lecture-hour on the target laptop. Record actual numbers before committing to SLAs.
