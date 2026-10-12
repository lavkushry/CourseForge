# Native detail preservation and bounded retention contract

Written 2026-10-12 before implementation. Source audit: legacy `app/academy.py`
cleanup_records deletes access events older than30 days, learning/admin/activity/
native detail older than90 days, expired ownership/player/auth/account-token/rate
rows. Legacy native detail and separate player ownership are distinct stores; the
Go player combines those concerns, so expiring a capability must not delete its
90-day administrator detail. Go auth currently cascades native detail deletion;
activity already retains a text login binding. Corresponding auth/session schema,
identity revocation, native/media access joins, activity lifecycle triggers and
administrator reports were read. No live database/provider data is a fixture.

## Migration 014 and immutable provenance

Preserve `playback_sessions.auth_session_id` as non-null immutable text, remove
its cascading auth foreign key, and keep account/lesson foreign-key cascades.
Add bounded device/IP snapshots, snapshot time, basis and truncation flag. New
native rows capture the exact matching current live login at server open time.
Snapshot/user/login/lesson identity cannot be edited later. New live inserts
without a verified, unsuspended matching login are rejected. A closed, explicitly
marked legacy import may preserve validated historical snapshots even when its
login no longer exists; this database seam is not a typed importer authorization.

Backfill existing rows from their current matching login using the provenance
`migration_login_record`, with migration capture time. This is not a reconstruction
of device/IP at historical native open time. New rows use `session_open`; closed
imports use `legacy_import`. Snapshot strings are bounded to220/100 characters;
clipping is disclosed by `snapshot_truncated`, never hidden. No token, token hash,
CSRF or provider data is copied into snapshot fields or administrator projections.

Before login deletion, close only native/activity rows matching that exact login
and owner and clear only their leases in the same transaction. Revocation also
closes that exact binding immediately; it does not erase detail or lifetime totals.
Native closure triggers retain bound activity provenance; unbound matching page
activity also closes. Another login's new native/page ownership must survive old
login revocation or deletion. Account/course/lesson deletion continues its existing
cascade policy; no orphan private detail or catalog reference is retained.

Retained native text is not authentication. Player pulse/claim/media and live
reports must continue to require current verified account, matching live auth,
current lesson access, open/unexpired native session and current lease. Current
playback/media source joins already provide this boundary; root owns any source
seam changes. Old media capabilities cannot become valid after cleanup; retained
rows cannot be rebound to a new login or reopened by snapshot mutation.

## Explicit SQL-only batch seam

No scheduler, HTTP cleanup route or automatic startup cleanup is enabled. Root
may call `retention.New(pool).Cleanup(ctx, kind, limit)` using the server/test clock
and an explicit known kind. Limit is1..1000 records; invalid kinds/limits fail before
writes. One transaction and a five-second context bound each call; no provider/model
or HTTP streaming work occurs. It returns the requested kind, bounded changed count,
server time/cutoff and deferred-work explanation where applicable. Repeating a
finished batch returns zero. Concurrent calls select/revalidate candidates and
serialize relevant learner rows before auth, player/activity and lease mutations.
No private IDs, snapshots, tokens or audit resources are returned by cleanup.

| Kind | Eligible operation |
| --- | --- |
| `activity_expiry` | Close at mostlimit open page sessions whose six-hour detail session, login or bound player is expired/revoked/missing; clear only matching leases, no credit or total changes. |
| `playback_expiry` | Close at mostlimit expired/revoked/missing-login native sessions only after bound open activity has been closed; clear only matching native leases. |
| `activity_leases` | Remove at mostlimit expired/closed-session activity leases; reset only their activity visibility baseline. |
| `playback_leases` | Remove at mostlimit expired/closed native leases; reset native baselines and only matching activity ownership via the existing lifecycle seam. Defer any binding with open linked activity until bounded activity closure. |
| `activity_detail` | Delete at mostlimit closed/expired page reports created more than90 days ago. Preserve lifetime activity/visits. |
| `playback_detail` | Delete at mostlimit closed/expired native reports created more than90 days ago only when no activity references or playback lease remain. Avoid unbounded FK updates; preserve watched totals/progress. |
| `auth_sessions` | Delete at mostlimit expired logins only when matching open native/activity rows and leases have been closed/removed. Revoked-but-not-yet-expired rows are retained until expiry, matching the existing policy. |
| `access_events` | Delete at mostlimit events older than30 days. |
| `admin_audit` | Delete at mostlimit audit rows older than90 days. |
| `account_tokens` | Delete at mostlimit expired one-time rows. |
| `login_limits` | Delete at mostlimit expired admission rows; active export/login windows remain. |
| `activity_open_limits` | Delete at mostlimit expired one-minute activity-open windows. |

Caller ordering for draining a finite backlog: activity_expiry, playback_expiry,
activity_leases, playback_leases, activity_detail, playback_detail, auth_sessions,
then independent event/token/admission cleanup. Dependency guards can defer a native
or login row until earlier batches finish. More thanlimit eligible records needs
another explicit call. Backlog age/count metrics and scheduling are root's future
work; a zero changed count does not promise no deferred references exist.

Historical learning_events has no current destination table, so that retention
kind remains unavailable rather than fabricated. Focus, assessments, notes,
bookmarks, progress, activity/watched aggregates and visits are not session-detail
cleanup targets. Lifetime values are never reconstructed by summing remaining
sessions. Expiring rows does not award time, completion or learning credit.

Direct user/account/catalog deletion can affect multiple matching dependent rows,
as the domain action requires. Its fan-out and index cost remain unmeasured and
are not claimed bounded by the batch limit. The scheduled cleanup seam uses guards
and bounded candidate revalidation to avoid hidden unbounded lifecycle cascades.

## Reports and verification

Administration switches native device/IP to immutable native snapshots with basis,
capture time and truncation metadata. Native detail then survives login cleanup and
is reportable as closed/inactive; current auth joins continue to drive live status.
System retention metadata separates policy, schema capability and unscheduled
execution. Existing migrated snapshots remain labeled as backfilled current-login
records. CSV contains snapshots without capabilities; provenance is explicit.

Tests use disposable PostgreSQL and public auth/activity/native/report/media
interfaces, with synthetic controlled clock and independent service instances.
Verify snapshot immutability/current source and backfill basis, exact login deletion/
revocation, another login takeover/new open, disabled old media, account/course
cascades, bounded/deferred cleanup, 30/90-day and expiry boundaries, independent
lifetime aggregates, no double credit, idempotent/concurrent batches and cancellation.
Root owns shared activity test expectation changes, API/OpenAPI integration and
migration application. Browser/admin device evidence, typed legacy import, durable
cleanup restart rehearsal, scheduler/resource measurements and production release
remain separate gates. No learner/API/media/AI capacity claim follows from this slice.
