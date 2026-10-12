# Curated labs workspace and submission contract

Grounded in `app/labs.py`, `lab_tracks.py`, trusted `lab_graders/{grade,tracks}.py`,
`academy_worker.py`, the five lab routes in `main.py`, and active editor/result
flows in `static/{app,core}.js` and `index.html`. This slice does not execute code,
deploy containers, modify production or claim sandbox isolation from synthetic grades.

## Catalog and private workspace

Preserve eight immutable curated IDs: python-log-analysis, shell-http-analysis,
k8s-resilient-service, sql-customer-revenue, pyspark-order-analytics,
docker-hardened-service, ansible-idempotent-web and backend-request-handler.
Preserve title, type, objective, filename, starter content, tip, category and level.
Known Dockerfile/Ansible exercises are static checks, not deployments; SQL is
read-only graded fixtures, Kubernetes optional kind validation uses a deliberately
owned local cluster, and Spark/Python/Shell/backend execution belongs only inside
the proven restricted runner. Never accept a learner-selected filename, grader,
image, executable, command, slug definition or arbitrary host path.

All lab operations require a current verified unsuspended account/session. Every
workspace, revision, submission, feedback and command is private to its owner;
administrators do not gain other learners' files. Standalone labs have no lesson or
enrollment dependency. Linked practice adds its own original path/source scope.
Workspace content is SQL data, never executed or materialized on the host here.
Source files stay bounded100,000 UTF8 bytes and revisions retain SHA256 of the exact
bytes. Editors use optimistic revision; stale writes conflict. Exact command retry
returns the original acknowledgment, without overwriting later files or duplicating
sessions/submissions. Owner/authentication are rechecked before every acknowledgment.

## Routes

- GET `/api/v1/labs`: eight curated entries; no starter content in catalog;
  `grading_available=false` until an actual proven queue/runner/verifier is configured.
- POST `/api/v1/labs/{slug}/start`: `{}`, CSRF/Idempotency-Key; creates an actual
  owned SQL workspace at revision1 using the fixed starter, returns original editor
  metadata/session/content. It does not imply a runnable grader.
- GET `/api/v1/lab-sessions`: bounded private list with created-time/ID cursor.
- GET `/api/v1/lab-sessions/{id}`: current owned editor content/revision/hash,
  current status and accepted latest feedback, plus honest grader availability.
- PUT `/api/v1/lab-sessions/{id}/file`: `content`, `expected_revision`, CSRF/key.
  Bound the JSON transport sufficiently to preserve the legacy100KB UTF8 file
  limit; standard16KiB decoding cannot silently shrink this editor feature.
  Persist an immutable revision before acknowledgment. New edits clear displayed
  latest feedback but retain all submitted snapshots/results in history.
- POST `/api/v1/lab-sessions/{id}/submit`: `expected_revision`,
  `validate_in_kind=false`, CSRF/key. Kind validation only for Kubernetes and only
  with proven owned-cluster capability. Without actual execution capability503 and
  no fabricated submission/job; known unavailable kind capability503. Available
  submission202 means durable queuing, never completed grade. Exact retry keeps the
  original immutable submission even after later edits.
- GET `/api/v1/lab-sessions/{id}/submissions`: private bounded immutable input
  snapshot metadata/job status/grade summaries, stable created-time/ID cursor.
- GET `/api/v1/lab-submissions/{id}`: own accepted feedback and immutable revision
  metadata; never reveal another learner's source, raw execution logs or credentials.

Source edits/sessions require durable private idempotency. Lists limit1..100.
All accepted writes commit before response. No client grade/status/owner/timestamp
is accepted. Session/file IDs and filenames are server-owned. Account deletion
cascades SQL records; artifact retention belongs to the runner bridge and importer.

## Shared job and trusted publication seams

The existing queue requires a lesson ID, while these labs are standalone. Do not
invent lesson scope or add a second lease queue. A root-owned shared queue seam must
support explicitly typed lab session/submission scope without a lesson, current
owner/verified account checks in admission/claim/read/cancel/publication, short
transactional enqueue, shared resource budgets, fencing and outbox semantics.

An optional `SubmissionQueue.Enqueue` performs bounded SQL inside the caller's
transaction and inserts a real owned shared job. The module validates that returned
job ID against durable owner/kind/typed immutable submission metadata before commit.
Default executor availability is false. Payloads contain bounded snapshot references,
not100KB content in the queue's64KB payload. A trusted executor fetches the immutable
owned snapshot through the separately integrated internal protocol.

`PublishResult` runs inside the existing fenced `Queue.Complete` transaction,
rechecks authoritative owner/job/payload/submission and exact SHA256/grader version,
and requires an optional trusted runner evidence verifier. An executor result alone
cannot assert its own sandbox provenance. The verifier must prove the durable
execution receipt belongs to this job/fence/submission and an approved restricted
runner/image/grader before accepted grade persistence. A top-level pass requires
all nonempty checks and requested kind validation; feedback names/details are bounded.
Immutable accepted grade IDs are exact evidence IDs used by practice; grade owner,
session/slug, version/hash and original completion time remain authoritative.
Public job status returns a safe submission/grade reference, not execution output.

## Required proof and remaining gates

Disposable actual PostgreSQL/identity-wrapped HTTP/race tests prove private catalog/
workspaces, source byte bounds, owner/admin/CSRF denials, stale/concurrent writes,
durable retries after edits, unchanged input snapshots, truthful unavailable execution
and kind behavior, owned pagination and no supplied grades. Positive queue/fenced
publication tests depend on the real shared queue scope seam and trusted receipt
adapter, and must be labeled distinctly from runner proof.

Real sandbox testing must prove no network, read-only root, no capabilities/privilege,
non-root execution, bounded CPU/memory/PIDs/time/output, isolated read-only workspace/
grader mounts, no Docker socket/host/cloud credentials, cancellation/cleanup and
concurrent tenant isolation. Existing Docker flags are intended requirements, not
evidence that a new runner passes. Owned-kind provenance and Spark's special resource
envelope remain explicit gates. Browser editor/result navigation, actual lab/practice
bridge, semantic file/SQL/artifact import, restore/recovery and throughput remain open.
No10,000-learner, media or AI capacity claim follows from this core.
