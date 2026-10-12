# Administrator report backend handoff

Updated 2026-10-12. This is an additive backend slice, not full administrator or
production parity. The prewritten source-derived contract is
[ADMIN_REPORTS_CONTRACT.md](ADMIN_REPORTS_CONTRACT.md). Only
`backend/internal/administration/**` and these administrator documents changed;
no schema, cmd, OpenAPI, web, shared activity/playback/identity, staging or production
changes were made.

## Integration

Construct `administration.New(pool)` and `Register(app.Mux, auth)`. It adds 12 route
patterns under `/api/v1/admin`:

- `/overview`, `/course-funnels`, `/learner-reports`
- `/users/{id}/learning-report`, `/users/{id}/reports/{section}`
- `/player-activity`, `/player-activity/export`
- `/playback`, `/playback/export`
- `/audit`, `/access-events`, `/system`

All use GET and require current verified administrator authentication. Existing
identity user/invitation/account/session/enrollment/role routes remain registered
without duplicates. Root owns OpenAPI, API wiring and UI integration.

Optional `Service.Capabilities` fields are injected once before serving from actual
application configuration: registration mode, nullable email/provider configured
flags. Their default null flags mean unknown; the report does not inspect credentials
or call a provider. Root should supply only already-known booleans and the configured
registration mode. `Service.Now` is a test clock seam; normal default is server time.

Response conventions:

- Learner list: `users`, `total`, `next_cursor` and separate accounting basis fields.
- Learner report: `user` contains explicit account metadata and independent counts/
  totals; `sections` and `unavailable_sections` enumerate supported history seams.
- Detail section, audit, access and funnels: `items`, `next_cursor`; per-user section
  also includes `section`.
- Activity/playback report: `sessions`, `total`, `next_cursor`, `summary` (learners,
  lessons and retained `session_seconds`), `basis`, `period`, `retention_days`,
  `server_now` and disclaimer. Detail period sums are never lifetime totals.
- System: actual SQL tasks, pending invitation count, bounded course/mapping/duration
  facts, audit and capability/retention/unavailable metadata. `course_count`,
  `course_limit=100` and `courses_truncated` disclose its bound; use course-funnels
  and existing catalog administration for complete paginated course inspection.

Report pagination uses `limit=1..100` and a bounded timestamp/ID cursor. Activity/
playback filters use `days=1..90`, literal `q`, exact `course_id`/`user_id`, and
`status=all|live`. Exports accept complete filters, not `limit`/`cursor`.

## Behavior and safety

Explicit SQL projections expose only the intended report fields. Independent
subqueries prevent join multiplication of enrollments, completion, page time,
watched time, focus and note/bookmark/assessment counts. Per-user report sections
always filter their owner. Raw notes, card answers, assessment answers/feedback,
password hashes, CSRF/session/media capabilities and provider mappings never appear.
Administrative email/device/IP inspection is deliberate and requires current admin.

Activity lifetime comes only from `lesson_activity_totals`. Playback wall time,
coverage, resume and native visible diagnostics remain separate. Focus excludes
break/canceled sessions and caps running elapsed by server time and duration.
Current live predicates recheck publication/enrollment, learner verification/status,
login/session/lease expiry, exact binding and any native ownership. Waiting/hidden
pages, missing bound players and revoked learners are not live. Historical admin
records remain inspectable after course access revocation. Administrator current
course access remains an explicit exception, including unpublished courses.

Every report runs in a coherent repeatable-read transaction, locking current admin
and login so role/revocation cannot race an acknowledged snapshot. A five-second
request deadline bounds SQL work, and rollback cleanup has its own one-second bound.
All JSON/CSV/errors are private/no-store; CSV is nosniff with fixed filenames. Database
errors disclose no SQL/internal details.

CSV uses encoding/csv plus formula-prefix protection, including Unicode whitespace
and leading tab/CR/LF. It is capped at 10,000 rows and 16 MiB encoded output, with 64 KiB
per explicit JSON detail row. SQL text-byte lower bounds reject known oversized sets
before materialization, and the final encoded output is checked independently. It
never truncates a matching set or sends a partial file. Reports that exceed limits
return 413 with narrower-filter guidance; pagination parameters on exports return 400.

Both CSV types share ten successful snapshots per admin per hour via the existing
`login_limits` namespace `admin-report-export:`. Admission, audit and snapshot commit
before HTTP bytes; failed/oversized attempts commit neither quota nor audit. Current
scope is revalidated for each export attempt. PostgreSQL snapshot/deadlock conflicts
retry the whole uncommitted transaction, at most 16 attempts with jitter under one
five-second request deadline; exhaustion is 503 with Retry-After. Connections are
released before sending the prepared file. No new schema or invented queue job exists.

Two faults were reproduced and corrected by public handler tests: concurrent quota
updates returned503 snapshot conflicts before bounded transaction retry was added;
large byte-bound reports timed out before413 until SQL size preflight was added.

## Verification

Commands ran from `backend/` with an explicitly supplied synthetic loopback
`CF_TEST_DATABASE_URL`. testutil created/dropped independent `cf_test_*` PostgreSQL
schemas and applied source migrations only inside them.

```text
go test -race ./internal/administration -count=1
ok courseforge/backend/internal/administration 27.014s

go test -race ./internal/administration -run 'TestOverviewLearnerProjection|TestConcurrentExports|TestCSVByteBudget' -count=1
ok courseforge/backend/internal/administration 6.826s

go vet ./internal/administration
passed

gofmt -l backend/internal/administration
no files
```

The full run contains 15 top-level tests: 14 real-PostgreSQL/public-handler integration
tests and one pure CSV-cell test. The focused run followed the bounded rollback
cleanup and an additional assertion separating wall watched time, coverage and resume.
Tests cover all route authentication/role denial, current revocation, independent
learner/global totals, 14 owner-scoped detail sections, grading-secret exclusion,
explicit unavailable sections, literal search, cursor ties/period/field bounds,
current live predicates and historical visibility, formula-safe real CSV/header,
shared quota/recovery/audit, row/byte rejection without side effects, exact 10,000-row
complete export, login-dependent retention, SQL system facts, course cap disclosure
and full funnel pagination. Sixteen concurrent exports across two independent service
instances produce exactly ten successful snapshots, six 429 responses, ten quota
credits and ten audits. This is scoped correctness evidence, not learner capacity.

Root should run the integrated regression suite after registering this module. No
independent source-blind/browser/device verdict is claimed here.

## Explicit remaining limits and full-parity gates

- No administrator TypeScript UI, download/browser flow or source-blind review yet.
- Legacy learning-event chronology has no destination table or recording seam here;
  `events` reports are 503, and overview labels its actual activity-session rows.
- Lab result reporting remains503 until real lab storage/adapters are integrated.
- Legacy engagement/teacher AI insights, streaming interaction analytics, external
  service-check history and provider mapping refresh remain unavailable. SQL job
  counts/mapping counts do not claim service health, throughput or provider readiness.
- Access events currently store event/time/user only; missing legacy device/IP fields
  are disclosed. Activity details retain their own snapshots. Native details currently
  use current login device/IP, not an immutable native snapshot.
- **Native session retention is not yet 90 days independently of login cleanup:** the
  current playback auth foreign key cascades deletion. Deleting a login removes its
  native detail, while watched lifetime totals survive and activity detail remains
  closed with its snapshot. System metadata discloses the dependency. Root/future
  retention migration must preserve closed native records and safe device/IP
  snapshots before activating cleanup; no scheduler was activated here.
- Legacy 30-day access/90-day detail/90-day audit policy is reported separately from
  scheduler execution. Future bounded SQL retention/audit cleanup needs its own
  lifecycle/privacy/recovery evidence and is not scheduled by this module.
- More than 10,000 matching rows or 16 MiB requires narrowing filters. Queued bulk
  export, artifact retention/download authorization and cancellation need a real
  fenced adapter before larger exports can be promised.
- Typed legacy report/event/device/account migration, retained snapshots, backup/
  post-write recovery and semantic comparisons remain required.
- Global count/subquery cost, correlated per-user projections, live predicates,
  quota contention, CSV memory and pool/lock waits have not been measured under
  the 10,000-concurrent-learner workload. API, media and AI capacity remain separate
  targets without a claim from these tests.
