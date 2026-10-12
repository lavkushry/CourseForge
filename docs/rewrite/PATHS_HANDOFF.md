# Learning path and topic assessment core handoff

Completed 2026-10-12. This is an additive backend core, not full legacy path,
AI-generation or practice parity. Production and shared staging were not modified
by this assignment. The existing unrelated dirty tree remains intact.

## Delivered behavior

`backend/internal/paths` registers 12 authenticated versioned routes described in
`PATHS_CONTRACT.md`: private bounded path listing/detail, explicit manual creation
and refresh, deletion, prerequisite-aware checklist completion, source-backed
topic assessment curation/read/attempt/history, and honest unavailable generation
until an actual executor is configured. Manual provenance remains explicit.

Every accepted local mutation commits before acknowledgment, requires a durable
idempotency key and rechecks active identity/current course scope. Manual command
snapshots replay without resurrecting deleted records, while rejecting deleted,
moved or revoked citations. Concurrent optimistic-revision writes have one winner;
identical concurrent assessment attempts produce one durable result. Checklist,
watch completion and practice mastery remain separate signals.

Questions hide answer indices and explanations through the assessment GET boundary.
Accepted attempts retain immutable private feedback/source snapshots after same-scope
source text changes; new attempts reject outdated fingerprints. Archived citations
remain subject to current lesson/course/chunk bindings even after path refresh.

Typed generation payloads/results are validated by `Service.PublishResult` inside
the existing queue completion transaction. Authoritative owner/lesson/kind/payload
are reread from the running durable job, rather than trusted from caller metadata.
Publication validates current verified account, enrollment/publication, source
fingerprint, queued revision and source boundaries. Queue cancellation/stale fences
cannot publish. `GeneratedAssessmentID` is stable across worker retries.

`ProjectResult(job)` returns only an assessment/path resource reference for its
known typed namespaces; it performs no SQL and never returns generated content.
Generation acknowledgments call `Queue.PublicJob`, including completed submission
replays. API integration must set `q.ResultProjector = paths.ProjectResult`.
Shared queue HTTP projection is owned by the coordinator. Own resource endpoints
still enforce current private scope after following a reference.

Accepted generation retries compare normalized public commands against the original
owned job before rebuilding source fingerprints/checking current path revisions.
They return the same job/reference after refresh, checklist edits, same-scope text
changes or executor removal, while denying changed requests and revoked/deleted/
moved original citation scope. Lookup and access checks use the already-held module
transaction; replay performs no nested pool acquisition or new job submission.

`PlanningAdapter` implements the planner interface without reversing package
dependencies. It supplies bounded unlocked source-backed lesson candidates and
checks private/current source scope. Legacy stable path IDs preserve Python goal
case folding, course ordering, JSON spacing and ASCII/Unicode escaping.

## Files and integration seams

- `backend/internal/paths/{service,generation,assessments,planning,paths_test}.go`.
- `backend/internal/store/migrations/010_paths.sql`: five tables with owner FKs,
  bounded data checks and cursor/attempt lookup indexes. Apply only through the
  coordinator's isolated migration procedure.
- `docs/rewrite/PATHS_CONTRACT.md` and this handoff.

API: construct `paths.New(pool, q)`, leave `ExecutorAvailable=false` until a real
adapter exists, register on the authenticated API mux, set queue projector, and
assign `planner.Paths = paths.PlanningAdapter{Service: pathService}`. Worker: route
`path`/`learning_path` and `quiz`/`topic_assessment` payloads to this publisher;
ordinary lesson quizzes/reviews still belong to `learning.PublishResult`. Reject
unknown/mismatched product namespaces. Do not enable generation with a nil or
silently accepting publisher. The coordinator owns cmd/API/worker/OpenAPI wiring.

## Verification

With `CF_TEST_DATABASE_URL` explicitly pointing to the isolated local PostgreSQL
on port15439, `go test -race ./internal/paths` passed all **22 top-level tests** in
**39.143s**. `testutil.Postgres` creates/drops a disposable schema per test and
applies source migrations; no production or shared learner accounts were created.
The preceding 20-test run passed in33.438s; the 21-test projection run passed in
35.504s before the final generated replay changes.
`go vet ./internal/paths` passed and changed Go files were formatted.

Evidence includes identity-wrapped actual PostgreSQL HTTP tests for guest/CSRF/
Origin/unverified/outsider/admin denial; DAG/source/page bounds; prerequisite and
dependent-clear behavior; concurrent revisions/duplicate attempts; immutable
feedback and citation revocation; no-executor503 with no fabricated jobs; valid,
forged, stale, changed-source, canceled and revoked fenced publication; planner
candidate ownership; and Unicode stable ID/score thresholds. The final test follows
a completed generated assessment through job GET, job list, and product POST
replay after path revision/source text changes, proves no answer/feedback disclosure,
checks another learner denial and revoked assessment-reference access. Generated
path replay additionally preserves the original job after manual refresh/source
text changes, rejects changed requests/deleted citations and creates no extra job.

This is package evidence against disposable fixtures. It does not establish
staging route integration, a real executor, browser parity, process crash recovery,
performance defaults or 10,000-learner capacity.

## Explicit remaining constraints

- Generation's preliminary indexed-source snapshot admits1..40 selected chunks and
  rejects larger sets; the real syllabus/selection/lexical/embedding/DAG adapter
  must replace this bounded preliminary selection before production generation.
- The planner interface anchors a cross-course path to its first course. Candidates
  omit other-course topics and return an explicit warning; cross-course planner
  semantics remain open. Practice/lab candidate enrichment is unavailable.
- Path loading/fingerprinting uses bounded but potentially substantial per-step/
  source SQL work. No query-plan or capacity conclusion has been measured.
- Legacy generated syllabus graphs, source generation, adaptive practice/history,
  verified labs, tutor/companion and TypeScript path/assessment/practice views are
  separate missing integrations. Manual authoring is not a substitute for them.
- Semantic import must preserve legacy path/step/assessment/attempt IDs, times,
  citations/content, completion/history and provenance. New fingerprints are not
  interchangeable with the legacy syllabus fingerprint without a tested transform.
- Additive path deletion cascades active assessments/attempt rows; durable private
  command snapshots survive. The old app has no matching deletion route, and the
  product retention/import policy must be settled before production cutover.
- Worker/executor deployment, artifact/vector migration, crash/restore/retry
  rehearsals, actual-device browser checks and API/media/AI capacity gates remain.
