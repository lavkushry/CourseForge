# Private learning paths and topic assessment core contract

This slice implements the legacy path/step/assessment operations in
`app/learning_paths.py` and `app/assessments.py` and their current path, assessment
and practice UI dependencies. It is additive under `backend/internal/paths` and
migration `010_paths.sql`. The coordinator owns API/worker/OpenAPI registration.
No production service or shared staging migration is authorized by this handoff.

## Public operations and honest generation

All routes require an active verified caller and existing identity CSRF/Origin
rules for mutations. Private ownership remains mandatory for administrators too.
Every selected course must be published/enrolled for students; every source must
belong to that selected course and exist at a finite in-range timestamp. Revocation
is rechecked transactionally before acknowledged mutation/publication.

- `GET /api/v1/learning-paths`: bounded private list, stable ID order/cursor.
- `POST /api/v1/learning-paths`: request generated source-backed path using
  `course_ids`, `goal`, `expected_revision` (0 for new). Without a real configured
  executor return generation_unavailable503; no local/fake AI fallback. With an
  executor, durable typed `path` job202 is not successful generation.
- `POST /api/v1/learning-paths/manual`: explicit learner-authored path definition
  with `id`, `goal`, `course_ids`, `steps`, `expected_revision`. This is additive
  curation with `manual` provenance, never labeled AI. Step IDs are supplied stable
  IDs; imported legacy IDs must be retained. Bounds:1..8 courses,1..100 steps,
  goal3..180 characters, source-linked topics, acyclic valid prerequisites.
- `GET /api/v1/learning-paths/{id}`: source definition, provenance/revision,
  source fingerprint/outdated flag, independent manual completion, completed
  source-video count, latest assessment mastery/count and unlocked next step.
- `PUT /api/v1/learning-paths/{id}`: refresh explicit manual definition under
  optimistic revision; retain completion for unchanged step IDs, remove vanished
  completions and invalidate changed graph dependents. Generated provenance cannot
  be forged via this manual route.
- `DELETE /api/v1/learning-paths/{id}`: private deletion with expected revision;
  exact retry returns original command acknowledgment without resurrection.
- `PUT /api/v1/learning-paths/{id}/steps/{step_id}`: completion bool plus expected
  path revision. Completing requires completed prerequisites; clearing a step
  recursively clears completed dependents. It never grants quiz/lab/watch credit.
- `POST /api/v1/learning-paths/{id}/steps/{step_id}/assessments`:3..5 source-backed
  questions via durable typed `quiz` job with `product=topic_assessment` namespace.
  No actual executor means503; no changed/outdated path may generate/submit.
- `POST /api/v1/learning-paths/{id}/steps/{step_id}/assessments/manual`: explicit
  learner-authored practice questions with manual provenance. Each has4 distinct
  options, valid answer index, explanation and authorized nearby indexed chunk.
  These are practice signals, not independently validated mastery/certification.
- `GET /api/v1/assessments/{id}`: owner's immutable assessment snapshot; hide
  correct choices/explanations until an accepted attempt. Reading a historical
  assessment does not silently regenerate it.
- `POST /api/v1/assessments/{id}/attempts`: answer exactly every question with an
  index0..3; persist private immutable result/answer/feedback/source snapshots.
  Scores<70=needs_practice,70..84=developing,>=85=ready_for_review. A later attempt
  changes latest topic signal only; it never changes manual step completion.
- `GET /api/v1/learning-paths/{id}/assessment-history`: bounded private history,
  optional step filter, stable attempt IDs/order and original immutable feedback.

All accepted commands require Idempotency-Key. Manual definition, deletion,
completion, manual assessment and attempt command replay returns the original
snapshot even after subsequent edits/deletion, after rechecking current owner
and course scope; changed payload under the same key conflicts. Concurrent writes
at one expected revision have one winner. Never acknowledge before commit.
Public lists are bounded1..100; definitions/sources/results are bounded. HTTP
requests use the existing16KiB decoder; queued payloads/results retain queue limits.
Generation submission retries look up the original owned job before rebuilding
sources/checking the current revision. Normalized public command fields must match;
current identity, original selected courses and citation bindings are rechecked.
An accepted request returns the same job/reference after path edits, source text
changes or executor removal, without starting new generation. Changed commands
conflict; deleted, moved or revoked original sources deny replay. The returned job
status reflects its current durable lifecycle rather than freezing a queued state.

## Source and publication boundary

Core fingerprints deterministically include selected course/lesson identity,
source timestamps and indexed chunk text/time. A changed/deleted referenced source
marks a path outdated and rejects new assessment attempts. Existing results remain
immutable and private. Refresh uses explicit source definition and keeps stable
IDs; generated path results cannot add courses/lessons outside the queued snapshot.

`Service.PublishResult(ctx, tx, job, raw)` validates typed result version/product,
owner/account/selected course scope, complete source fingerprint and expected
path revision inside the queue's existing fenced completion transaction. The
coordinator must dispatch only matching path/topic-assessment product payloads.
A stale/canceled attempt cannot publish through `Queue.Complete`; bad/obsolete
results roll back completion and publication together. Executors run outside SQL
transactions; no network/model calls or goroutines are introduced in this module.

`ProjectResult(job)` claims only `learning_path`/`topic_assessment` namespaces and
returns resource references, never raw generated steps/questions/answer keys. The
coordinator injects it as `Queue.ResultProjector`. All shared queue HTTP responses
and this module's generation acknowledgments use `Queue.PublicJob`; unclaimed
namespaces follow that queue's fail-closed policy. Assessment/path GET endpoints
recheck current private ownership, course/source scope independently of the job
reference. Generation remains disabled unless a real executor is configured.

A SQL-only `PlanningAdapter` implements `planning.PathAdapter` without planning
importing paths. It validates private path/source scope and emits bounded unlocked
source-backed lesson candidates; planner completion never grants topic mastery.
Practice/lab candidate enrichment remains an explicit missing adapter.

## Required disposable PostgreSQL/HTTP/race evidence

Exercise two students sharing one course, outsider, admin and unverified users
through identity-wrapped HTTP handlers in disposable test schemas. Prove guest,
CSRF/Origin, owner/course/publication/source denial; stable list order/page bounds;
cycle/bad IDs/nonfinite/out-of-range source rejection; duplicate command replay;
completion prerequisite and dependent-clear behavior; one concurrent revision
winner; immutable historical assessment/results; wrong/partial answers; changed
source fingerprints; exact retries versus changed idempotency payload; generated503
with no queued jobs; valid typed job/publication and stale/revoked rejection;
planning adapter source/candidate scope. Run package race tests with an explicitly
configured disposable test database; skipped integration tests are not evidence.

## Remaining parity gates

Legacy path creation depends on generated syllabi, lexical/embedding dedup,
conservative/AI DAG suggestions, goal-focus ordering and old syllabus fingerprints.
Those real adapters/importer transforms remain incomplete; additive manual curation
is not a parity replacement for source-generated legacy paths. Original path/step/
assessment/attempt IDs, timestamps, citations/content, completions, practice links
and historic answers/results require semantic migration and provenance decisions.

Adaptive recommendations/history, verified lab grading/workspaces, tutor/syllabus/
companion, certificates, TypeScript path/assessment/practice panels, actual Python
executor deployment, worker integration, process crash/restart/recovery, artifacts/
vectors and capacity remain separate gates. No provider calls, production learners,
AI throughput or full-feature parity claim follows from this core handoff.
