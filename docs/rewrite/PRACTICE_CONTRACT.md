# Adaptive practice and verified outcome core contract

This slice ports `app/practice.py`, its three `app/main.py` routes, linked grading
publication in `app/academy_worker.py`, path practice badges in `learning_paths.py`
and `app/static/practice.js`. `academy.py` has no separate practice-credit route.
Its visible activity credit must remain independent. No production, runner or
shared staging changes follow from this backend assignment.

## Identity and evidence

Every operation requires a current verified, unsuspended account/session. Paths,
linked sessions, results and command keys remain private to their owner, including
administrators. Current selected course enrollment/publication and original
lesson/course/chunk citation scope are rechecked before reads and acknowledgments.
Same-scope old text changes retain historical results; new linked practice requires
a current path fingerprint. Path/source refresh never relabels an old lab attempt
as evidence for a different topic/source.
Stored subject fingerprints include the topic definition and current source
metadata/indexed chunk text. An unchanged topic retains its verified signal after
an unrelated goal refresh; a changed topic/source marks the old signal outdated,
omits it from currently passed labs and preserves its immutable historical attempt.

Checklist completion, watched-source progress, concept assessment, spaced review
self-rating and verified lab outcome are separate signals. Recommendations grant
no credit or inferred mastery. A verified pass requires an accepted immutable
grader evidence record owned by the learner, bound to the exact curated lab/session,
with nonempty checks and every check passed. A top-level pass with a failing check
is a failed outcome. No HTTP route accepts supplied `passed`, `checks`, result JSON,
owner, score or timestamp. Practice cannot issue quiz/review/habit/certificate credit.
New accepted evidence additionally requires a grader version, SHA256 submission
hash and completion time on/after session creation with at most one minute future
clock tolerance. Imported historic records retain their actual legacy provenance.

## Operations

- GET `/api/v1/learning-paths/{id}/practice-recommendations`: bounded stable-ranked
  curated suggestions using explicit legacy topic taxonomy, latest topic assessment
  and latest real lab result. Retain legacy action labels, priority formulas,
  assessment score, last pass/check/attempt counts and match reasons. Strong quiz
  signal with no prior lab attempt needs no targeted gap; a latest failure restores
  practice. A passed lab plus strong quiz signal closes that gap. Latest lab failure
  remains visible even after an older pass. Matching uses Unicode word boundaries;
  `sql` must not match `nosql`. Only the eight known curated lab IDs may be linked.
  Nil lab adapter means `available=false` with an explicit unavailable reason,
  never a claimed runnable lab. Source-backed lesson suggestions are returned
  separately with actual due-review counts and explicit reason/action; they grant
  no mastery and are not substituted for lab execution.
- GET `/api/v1/learning-paths/{id}/practice-history`: private immutable summaries,
  optional current step filter, stable `(completed_at,id)` cursor, limit1..100.
  Never return workspace content, raw grader output, assessment keys or other users.
- GET `/api/v1/learning-paths/{id}/practice-status`: private per-step/curated-lab
  latest outcomes, lifetime accepted attempt count and currently passed lab IDs.
  Latest accepted evidence defines current status; earlier attempts stay in history.
- POST `/api/v1/learning-paths/{id}/steps/{step_id}/practice/{slug}/start`: JSON `{}`,
  same-origin CSRF and Idempotency-Key. Current nonoutdated path, existing step and
  explicit taxonomy match are required. An injected SQL-only lab adapter creates an
  actual owned curated session; no adapter returns503 and stores no fake session.
  Durable exact retry returns the original acknowledged session after path edits,
  rechecking original private citation/course scope; changed key use conflicts.
- POST `/api/v1/practice/sessions/{id}/verified-attempts`: JSON `{evidence_id}` plus
  CSRF/idempotency, reuses an already accepted owned grader record through the lab
  adapter. This additive reconciliation route cannot run or grade code. Publication
  may also call `RecordVerified` inside the actual lab worker's fenced SQL completion
  transaction. Unique owned evidence IDs prevent duplicate credit across HTTP
  command keys, publication and worker retries. No adapter gives503.

All bodies use the existing16KiB decoder. Reads and local transactions perform
bounded SQL only; no network, filesystem, Docker, goroutine or provider calls.
Adapters must have the same rule and verify durable owned job/runner provenance;
implementations running an executor inside SQL are invalid. Raw evidence is private
and bounded. Existing lab sandbox/deployment/workspace APIs remain a separate slice.

## Storage and retention proposal

Migration012 supplies owned `practice_sessions`, append-only `practice_attempts`
and durable `practice_commands`. The lab session reference cannot target an absent
lab table; the real lab adapter owns its session/grade lifecycle, and the future lab
schema must add the tested composite owner FK/retention bridge. Path/account deletion
cascades live linked sessions/attempts, matching this rewrite's explicit path delete.
Private command snapshots retain original citation scope until account deletion.
Import must preserve legacy session/attempt IDs, path/step/lab IDs, original times,
checks/results and insertion-order provenance; do not fabricate verified evidence.
Native latest status orders accepted records by a durable monotonic acceptance
ordinal, preserving the legacy insertion-order rule even when completion timestamps
arrive out of order. History uses bounded completion-time/ID pagination. Legacy
attempt IDs can serve as explicit imported evidence references; they must not be
relabeled as native runner evidence. Restore/reseed the acceptance sequence after
preserving legacy insertion ordinals.

## Required evidence and remaining gates

Disposable PostgreSQL plus identity-wrapped HTTP tests prove cross-user/admin/
CSRF/Origin denials, taxonomy boundaries, current source/review/assessment signals,
transparent ranking/latest failure, bounded pages, nil-adapter truthful503/no writes,
start/reconcile idempotency, concurrent duplicate evidence, forged/mismatched owned
grade denial, revoked scope and immutable history after refresh/source text changes.
The test adapter reads actual persisted synthetic session/evidence fixtures, not
caller-provided grades; it is not real sandbox/runner proof.

Actual curated labs, fenced worker/adapter deployment, TypeScript practice views,
path badge integration, semantic imports/recovery and throughput remain open.
The existing planner anchors cross-course paths to their first course; this module
does not claim to resolve that separate planner limitation. 10,000 learners remains
a target with separate API/media/AI verdicts.
