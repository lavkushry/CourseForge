# Adaptive practice and verified outcome handoff

Completed 2026-10-12. This is a private practice core with a truthful optional
lab integration seam. It does not implement or deploy a runner, lab workspace,
grade executor or browser practice view. No production/shared staging changes
were made. Unrelated dirty files remain intact.

## Delivered behavior

`backend/internal/practice` registers five authenticated routes described in
`PRACTICE_CONTRACT.md`: recommendations, immutable paginated history, per-topic
verified status, source-linked curated session start and reconciliation of an
already accepted owned grader record. The legacy three practice routes preserve
their purpose; status/reconciliation are additive. The source audit found no
separate practice-credit route in `academy.py`; linked grading belongs to
`academy_worker.py`/`practice.py` and remains separate from visible activity.

Recommendations use all eight legacy curated lab IDs and explicit topic terms,
Unicode word boundaries, latest accepted topic assessment and lab results, original
priority/action rules and stable tie ordering. A strong concept result plus latest
real lab pass closes a targeted gap; a later accepted failure reopens it, even when
its recorded completion time is earlier. Due private source-linked review counts,
source-video completion and concept assessment remain explicit separate signals.
Source lesson suggestions grant no mastery, completion, habit or certificate credit.
Nil adapter returns unavailable lab suggestions and start/accept503, never fake
sessions or grade success. Recommendation results are bounded1..100 with explicit
total/truncation; history supports stable completion-time/ID cursors1..100.

Linked start requires active private scope, current path fingerprint, existing topic
and a curated taxonomy match. A SQL-only adapter creates the actual owned session.
Durable exact start/accept command retries retain their original acknowledgments
after subsequent edits, after rechecking original course/citation bindings. New
accepted grades additionally recheck current path access. Source fingerprints are
per-topic rather than whole-roadmap: unchanged topics keep their verified signal
after unrelated goal refresh, while changed topic/source content cannot inherit
old verification. Historic results remain immutable and private.

Verified outcomes require an accepted persisted evidence record with matching owner,
session and curated lab, grader version, SHA256 submission hash, completion time
after session creation and1..128 unique checks. Every check and the top-level result
must pass. Browser grades/owners/timestamps/checks are rejected. Unique owned evidence
IDs and a transaction-scoped evidence lock prevent duplicate attempts across command
keys/retries. Latest status uses a durable acceptance ordinal; an SQL trigger rejects
attempt updates. Public summaries omit raw grader evidence/workspace content.

## Files and integration

- `backend/internal/practice/{service,recommendations,outcomes,practice_test}.go`.
- `backend/internal/store/migrations/012_practice.sql`: owned linked sessions,
  immutable attempts and durable command snapshots, with owner FKs and lookup/page
  indexes. It is source-only until coordinator applies it in isolated staging.
- `PRACTICE_CONTRACT.md` and this handoff.

Construct `practice.New(pool, pathService)` using `paths.Service.ReadPath` and
register on the authenticated API mux. Leave `Labs=nil` until the real typed
SQL-only adapter and restricted runner evidence are proven. `Labs.Start` must create
durable owned curated session state; `Labs.Grade` must read immutable accepted
owned fenced runner evidence. Neither can run IO, a model or code inside SQL.
`RecordVerified(ctx,tx,principal,session,evidence)` supports transactional publication
or reconciliation. It enforces a currently valid account/session; a future worker
publisher must settle authenticated principal lifetime policy and supply a valid
principal, rather than passing only a queued owner ID. Actual worker fencing and
grader persistence are the lab module's responsibility and remain unproven here.

Root owns cmd/API/OpenAPI wiring and path badge/UI composition. Current paths do
not embed practice status automatically; use the status endpoint or a reviewed
composition adapter. The planner's first-course anchoring for cross-course paths
is unchanged. No lab planning adapter or fake lab candidates were added.

## Verification

`CF_TEST_DATABASE_URL` explicitly pointed to the isolated PostgreSQL on port15439.
`go test -race ./internal/practice` passed **15 top-level tests in34.106s** using
disposable testutil schemas. The lab adapter used in tests reads actual persisted
synthetic lab session/grade fixtures; it never takes supplied HTTP grades and does
not represent a real restricted runner. `go vet ./internal/practice` passed; Go
files are formatted.

Evidence covers current identity/admin/other-user/CSRF/Origin guards; Unicode
taxonomy boundaries; honest unavailable routes/no session creation; source review,
watch and accepted assessment signals; durable start/accept acknowledgments and
changed-key denial; outdated/unmatched/unreviewed lab denial; owned persisted grade
validation and all-check conjunction; malformed owner/session/lab/provenance/check/
timestamp rejection; eight simultaneous evidence reconciliations yielding one
immutable accepted attempt; latest accepted failure versus older pass; stable
history pages; preserved historical pass after text changes; revoked original and
current path scope; null/missing-key bounds; unchanged-topic goal refresh versus
changed-source verification invalidation. No unrelated learning_credits are issued.

## Remaining gates and limits

- Real labs catalog/session/file APIs, starter/workspace artifact creation, sandbox
  resource/cancel limits, grading, durable fenced evidence adapter and worker crash/
  retry recovery are not implemented by this slice. Adapter capability is not proof
  of runner safety or throughput; keep it nil until those gates pass.
- The absent lab schema prevents a real composite owner/session FK today. The
  future lab module must add a tested retention/deletion bridge. Current path/
  account cascades remove live linked sessions/attempts; private command snapshots
  survive path deletion and cannot resurrect a workspace.
- Semantic migration must retain legacy session/attempt/path/step/lab IDs, original
  times, raw results and insertion-order provenance. Imported evidence references
  must remain explicitly legacy; never invent native grader versions/hashes. Restore
  the acceptance sequence after importing legacy ordinals.
- TypeScript practice recommendations/history/path badges and actual lab navigation
  remain browser parity gates. Source suggestions are additive and do not replace
  the missing runnable exercises.
- Ranking/status and per-topic source fingerprints use bounded but potentially
  substantial SQL over the path's sources and lifetime attempts. Query-plan/load
  measurements, full recovery/import tests and API/media/AI capacity remain open.
  No performance default, 10,000-learner or full-feature parity claim follows.
