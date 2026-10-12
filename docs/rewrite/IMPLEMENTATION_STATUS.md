# Rewrite implementation status

Objective: implement the full Go/TypeScript plan with Odysee, preserve the currently
implemented UI, add premium discovery/player behavior and establish scoped
10,000-learner capacity. Migrate on the existing server after all production gates
pass. This objective remains active; current slices do not authorize cutover.

Updated 2026-10-12. Existing unrelated uncommitted Python/UI work is preserved.

## Current work

Implementation began 2026-10-11 in additive `backend/` and `web/` directories.
The current system remains Python/SQLite behind the existing Cloudflare tunnel.

| Milestone | Status | Evidence needed |
| --- | --- | --- |
| M0 contracts/baseline | Scoped baseline and exhaustive source inventory recorded | 316 operations:164 legacy route pairs,98 UI flows,54 worker/operator operations. Full semantic/browser/migration gates remain open. |
| M1 Go learning flow | Implemented and scoped HTTP/race evidence | Auth/access/catalog, private progress/notes, cross-replica records and graceful restart evidence. Full lifecycle/migration parity remains open. |
| M2 player/media | Implemented foundation; release gates open | Typed player, durable pulses/ownership, Odysee gateway and realistic media simulator; three browser engines and mobile viewports. Full capacity/device/provider gates remain open. |
| M3 product/jobs/migration | In progress | Durable queue/fencing/outbox; bookmarks/reviews/quiz, planning/habits/focus, certificates, paths/assessments and standalone activity wired. Safe job results and namespace publication integrated. Learning UI, adaptive practice and admin reports underway; strict source inventory and read-only snapshot preflight. Remaining product/adapters/importer/recovery gates are open. |
| M4 scale/resilience | Pending | Named topology, target-load runs, faults, media/provider verdicts |
| M5 release | Pending | Cutover and post-write recovery evidence plus real devices/provider scale |

Use `compose.rewrite.yaml` for the separate development/test PostgreSQL instance.
It uses loopback ports and synthetic credentials. No production service/database
replacement is performed by the development stack.

## Evidence and its limits

- M1 independent HTTP contract: **116/116** cases in
  `M1_HTTP_BEHAVIOR.json`. Graceful API/PostgreSQL restart readback: **5/5** cases in
  `M1_HTTP_RESTART.json`, with restart metadata in `M1_RESTART_EVENT.json`. This
  does not prove process-crash or primary-storage-loss durability.
- Combined Go race run against disposable PostgreSQL schemas passed all tested
  packages after planning/displacement integration: API79.125s, jobs17.662s,
  learning28.753s, playback15.649s, planning37.596s, media1.298s; unchanged
  config/identity/observe packages reused passing race results. `go vet ./...`
  passed. This run predates the later resume-point decoder fix and unfinished
  certificate/path modules; resume-only regression and duration/completion checks
  subsequently passed-race8.388s. The full changed API package passed-race75.130s.
- Integrated race regression after paths/activity/job privacy wiring passed
  jobs27.666s, learning29.042s, paths58.963s, activity53.424s,
  playback18.141s, certificates22.479s, API71.035s, router1.025s and media1.241s;
  API/worker commands compile. Planning initially failed because its fixed-noon
  fixture renewed a playback lease into the real clock's past. That accepted-action
  case now anchors its controlled clock to current UTC; the full planning race
  rerun passed27.535s. All changed package vet checks pass. The result retains this
  failure/rerun provenance; it is not one uninterrupted all-package passing run.
- Earlier M2 browser evidence records26 unit cases,40 fixture browser cases and10
  real-stack browser cases. Cinematic discovery/classroom work then passed60
  fixture checks across Chromium/Firefox/WebKit and mobile viewports. Lesson-error
  recovery passed35 fault checks and37 unit cases. The dedicated-gateway handoff
  records25 unique real-Go passing cases across five profiles:20 passed in the
  full run and the affected sign-in case passed in a five-profile fresh-identity
  rerun after seeded-account429 responses. This is combined provenance, not one
  uninterrupted25-case passing run; see `UI_PLAYER_HANDOFF.md`.
  Viewports are not real-device proof. Screenshots are under
  `output/playwright/courseforge/`.
- API-issued synthetic sessions served real byte ranges through the separate Go
  media entrypoint; HEAD, guest denial and released-lease denial passed **11/11**
  checks in `STANDALONE_MEDIA_BEHAVIOR.json`. This is one-session correctness,
  not throughput or live Odysee proof.
- Read-only migration preflight passed **22** synthetic tests. Regenerated source
  inventory records67 legacy tables,62 Go tables,10 feature tables and104 columns
  without destinations at that revision; it includes the unintegrated practice schema.
  Schema presence does not establish typed transformation or semantic equivalence.
  Preflight never writes PostgreSQL and deliberately does not approve
  migration; typed transforms/artifact/vector recovery are unfinished.
- Independent source-blind learning HTTP verification passed **164** probes with
  zero failures across both replicas, under `LEARNING_CONTRACT.md`; see
  `LEARNING_HTTP_BEHAVIOR.md`. Six clauses pass. Configured durable generation202
  remains blocked by missing indexed fixtures in this public HTTP test, though
  isolated queue/publication integration tests cover the foundation. An explicit
  zero/null generation-count finding was fixed and rechecked on both replicas.
- One live Odysee source preparation and32-byte range sample passed, using only
  configured server credentials and an existing provider mapping. See
  `ODYSEE_LIVE_SAMPLE.json`. `cmd/providercheck` is an explicit operator-only sample;
  it emits no provider URL, secret, bytes or mapping IDs. This does not prove
  decoding, complete lectures, the legacy failure cause or provider capacity.
- Planning acceptance is specified in `PLANNING_CONTRACT.md`;15 disposable-PG
  tests passed-race, and31 real HTTP checks across both isolated staging replicas
  passed (`PLANNING_STAGING_HTTP.json`). Migration007 is applied only in staging;
  cmd/api and OpenAPI now expose its18 routes. The path adapter is integrated;
  cross-course path planning remains limited to the first course. Browser/lab/reminder/semantic
  migration/restart gates remain open.
- Taken-over sessions remain permanently closed. Migration008 marks displacement
  so only correctly bound, currently authorized callers get409 ownership conflict;
  old media tokens remain invalid and other learners/revoked/expired sessions stay
  denied. Fresh deliberate takeover and negative/zero-credit regressions pass.
- Expired provider-source cache entries are invalidated on401/403/404/410 so the
  next authorized retry resolves afresh. Source generation checks preserve newer
  and unrelated entries. Media race tests pass; temporary503 does not flush cache.
- Certificate issuance/public verification passed10 disposable-PG HTTP race
  tests20.276s (`CERTIFICATE_HANDOFF.md`). Migration009 and API/OpenAPI wiring are
  live only in isolated staging.20 additional HTTP wiring/readiness/CSRF/replay/
  resume-privacy checks pass across both replicas (`CERTIFICATE_STAGING_HTTP.json`).
  The smoke did not mint a certificate; positive issuance is covered by package
  integration tests. Printable-page/API proxy forwarding and unknown-code404
  checks pass; TypeScript issuance, issued-page browser/print proof and
  imported-code semantic migration remain open.
- Paths/assessments passed22 disposable-PG HTTP/race tests39.143s
  (`PATHS_HANDOFF.md`). Migration010,12 API routes, the worker product router,
  pure safe job references and the planner adapter are integrated in isolated
  staging. Generated retries survive path/source text edits while rechecking
  current citation scope. Real source selection/model generation, UI/practice,
  semantic import, query cost and recovery remain separate gates.
- Standalone visible-page activity passed16 disposable-PG HTTP/race tests31.337s
  (`ACTIVITY_HANDOFF.md`). Migration011 and three API routes are staged. Activity
  is separate from native visible diagnostics, watch credit and focus. Native
  close/takeover/release/deletion update linked activity atomically; the reproduced
  deletion-lease defect is fixed. Frontend/admin/retention/import/recovery remain open.
- Integrated paths/activity smoke passed42 real HTTP checks across both staged
  replicas (`PRODUCT_STAGING_HTTP.json`), using two disposable synthetic learners
  that were removed afterward. It verifies private scope, immutable retries,
  prerequisites, no checklist mastery/completion inflation, planner links,
  separate page/watch/focus totals, duplicate credit and native release/takeover.
  It makes no media/provider/model/load or restart-durability claim.
- Job HTTP privacy regressions reproduced answer disclosure and revoked-course
  result access before correction. All job GET/list/submission replay and learning
  submission responses now project safe results. Unknown products/quiz raw output
  fail closed; raw private results remain retained. Jobs/learning race checks and
  worker namespace dispatch tests pass; see `JOB_PUBLICATION_HANDOFF.md`.

## Current operational and UI findings

The current deployed lesson error corresponds to observed successful legacy
session creation followed by media503 responses. Its exact upstream cause is not
yet reproduced with an authenticated production learner. No production QA account
was created. Go/TypeScript acceptance now includes abortable source preflight,
bounded transient recovery, specific sign-in/provider actions, deliberate takeover
and fresh-session retries that cannot steal another tab's lease.

The exhaustive Python/UI operation audit is recorded in
`FULL_FEATURE_PARITY.md` and `.json`:42 Python modules,48 current HTML/JS/CSS assets,
388 hashed files and316 concrete operations in that snapshot. Overall130 missing,
184 partial and2 unverified; no full-parity gate is complete. Learning-screen work
is in progress; findings still include incomplete TypeScript account/admin/
review/quiz/planning/path/practice/lab/tutor/certificate workflows even when some Go
APIs exist. Backend routes alone do not satisfy current implemented UI parity.

The current server/tunnel preference is recorded in `DEPLOYMENT_CONTRACT.md`.
The Quick Tunnel is temporary and limited to200 in-flight requests; it cannot
establish the target10k ingress/media acceptance topology. Production traffic needs
a stable configured tunnel/topology and measured origin/media capacity. No target
load/soak/real-device/live-provider/AI throughput verdict has been established.

## Work remaining before production

All `PARITY_CONTRACT.md` rows remain required: remaining learning paths/assessments/
practice/certificates, planning/engagement, real AI/import/lab adapters, private
reports/exports/retention, full typed SQL and artifact/vector migration, restored
retrieval citations, worker/crash/restart/failover recovery, real devices and the
complete capacity contract. Preserve one authoritative writer and the agreed
freeze/drain/import/verify/recovery sequence. A passing player demo or language
change does not waive these gates.
