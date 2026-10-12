# Visible activity backend handoff

Updated 2026-10-12. Backend-only slice, verified in disposable PostgreSQL schemas.
Production and shared staging were not changed. The prewritten behavior contract is
[ACTIVITY_CONTRACT.md](ACTIVITY_CONTRACT.md).

## Integration

Root can construct `activity.New(pool)` and call `Register(app.Mux, auth)` after
applying migration `011_activity.sql` in isolated staging. Add the three routes to
OpenAPI and verify routing before frontend integration:

- POST `/api/v1/lessons/{id}/activity-session`
- POST `/api/v1/activity/{id}/heartbeat`
- GET `/api/v1/me/learning`

Open requires an object; `player_session_id` and `visible` are optional. Bound opens
require the actual current playback session ID, not a media capability. Every
heartbeat requires `sequence`, `visible` and `elapsed_seconds`; `ended` is optional.
No Idempotency-Key is needed. Opening is intentionally a fresh page visit, while
heartbeats deduplicate by exact login-bound activity session and sequence.

`Service.Cleanup(ctx, before, limit)` deletes at most 1..1000 old detail sessions.
The coordinator owns the 90-day cutoff and future retention worker wiring. Cleanup
does not recompute totals or visits. It is not enabled automatically.

## Implemented behavior

One activity lease per learner is enforced by SQL and the playback-compatible
user/auth/source lock order. Opening another visible page does not steal an active
activity lease. New sequences credit only the minimum of client elapsed, positive
server elapsed and 20 seconds when both accepted states are visible, ownership was
already held, the gap is at most 30 seconds and any native player still owns
playback. Waiting, expired lease recovery, hidden return and deliberate native
reclaim first establish a zero-credit baseline. Duplicate/out-of-order sequences
cannot renew leases, move baselines or add time; backward clock movement cannot
move the accepted baseline backward. Final visible ended events can credit their
bounded last interval and close permanently. Closed/expired sessions cannot reclaim.

SQL triggers close bound activity on native close/takeover/deletion and clear or
rebaseline its matching activity lease on playback release/hidden. They preserve
binding provenance after player retention or login deletion. An integration test
reproduced a deletion ordering bug: the player FK could become NULL before the
playback-lease cascade found the bound activity, leaving a closed activity lease
until expiry. The player BEFORE DELETE trigger now explicitly clears its matching
activity lease before the FK action. It never clears another page's lease. An index
on non-null player bindings supports lifecycle lookups; no performance measurement
is claimed.

`lesson_activity_totals` is authoritative page time. Native visible diagnostics
never feed that aggregate. Summary separately projects lifetime page time,
accepted watched time and server-capped focus time, with no join multiplication.
Historical totals survive enrollment removal; content rows expose only currently
enrolled, published, nonempty courses. Explicit opens maintain last visits;
progress changes do not. Cursor ordering covers visited and unvisited courses and
stable ties. Detailed activity cleanup preserves lifetime totals and last visits;
login cleanup retains reports; account deletion cascades private activity state.

Authentication, current verification/publication/enrollment, exact login binding,
same-origin CSRF and bounded JSON are enforced. Current access is rechecked even
for duplicate or closed heartbeat responses. No browser response exposes login or
player capabilities, emails, device/IP reports or another learner's data. Session
open admission is a shared SQL 90-opens/60-seconds window with bounded Retry-After.

## Verification

Commands run from `backend/`, with `CF_TEST_DATABASE_URL` explicitly pointing at the
synthetic loopback PostgreSQL fixture database. The helper creates and drops a
fresh `cf_test_*` schema for each fixture and applies source migrations there.

```text
go test -race ./internal/activity -count=1
ok courseforge/backend/internal/activity 31.337s

go vet ./internal/activity
passed

gofmt -l internal/activity
no files
```

The package has 16 top-level tests and four distinct revocation subcases. They use
registered public HTTP handlers with current identity/CSRF and real PostgreSQL;
fixtures and aggregate/lifecycle inspections are test-local. Coverage includes:

- server-bounded accounting, final credit, duplicates, skipped/late sequences;
- waiting pages, hidden/visible return, lease expiry, long gaps, clock regression;
- invalid/null/oversized/malformed fields and no denied mutation;
- guest/unverified/cross-user/cross-login/CSRF/origin/lesson-scope denial;
- current enrollment, publication, login and suspension revocation on replay;
- bound playback release/reclaim, native hidden/close, takeover and retention;
- concurrent native takeover versus duplicate heartbeats with no post-displacement
  credit and exact preserved committed totals;
- 16 concurrent duplicate pulses and 16 concurrent page opens alternating two
  independent service instances, with one accepted credit/one owner;
- 90 opens split across two service instances, shared admission and recovery;
- six-hour session expiry, bounded detail retention, login/account cleanup;
- separate page/watch/focus totals, capped running focus, canceled/break exclusion;
- enrolled/published/nonempty course scope, all-status lesson/completion counts,
  inaccessible historical totals, stable cursor ties and last-lesson deletion;
- native `visible_seconds` coexisting with page credit without double-counting.

This is scoped correctness evidence. It is not a source-blind independent review,
a full backend regression verdict, browser/device evidence or a learner-capacity
measurement. Root should run the integrated regression suite after wiring.

## Remaining full-parity gates

The TypeScript page activity transport, standalone fallback activity, learner
summary UI and lifecycle/retry browser tests are still required. Coordinate exactly
one transport per current lesson generation, with identical sequence retries and
explicit hidden/final transitions; never add native visible time into page totals.

Admin detail/report/export parity, the scheduled bounded retention worker, typed
legacy import (including independently cumulative totals and visits), semantic
migration/recovery rehearsal and crash/restart proof remain open. The summary uses
bounded course pagination with correlated indexed-user projections; its query cost,
pool waits, lifecycle trigger fan-out and admission/account lock contention have
not been measured at the 10,000-learner target. No API, media or AI capacity claim
follows from these tests.
