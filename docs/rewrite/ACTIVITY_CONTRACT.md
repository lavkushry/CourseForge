# Visible lesson activity and learner summary contract

Sources: `app/academy.py` (`open_activity`, `heartbeat`, `my_learning`,
`cleanup_records`), `app/player_sessions.py` ownership/takeover, activity/visit
schema and console retention in `app/migrations.py`, separate native playback
accounting in `app/native_player.py`, the 15-second transport and account history
copy in `app/static/academy.js`, and activity/player tests in `tests/test_academy.py`
and `tests/test_player_sessions.py`. This contract precedes implementation.

## Accounting and ownership

Visible lesson-page activity is browser-reported page visibility bounded by server
time. It is not watched video, playback position/coverage, focus timer time,
completion, quiz success, practice or mastery. Opening a page credits no time.
One learner has at most one activity lease across accounts' tabs/devices and API
replicas. Lease duration is the legacy 20 seconds; expected heartbeat period is
15 seconds. Opening another page does not displace an active lease. Opens update
the per-course last visit even when that page is waiting for activity ownership.

Heartbeats have strictly increasing accepted sequences (1..1,000,000,000);
duplicate/older sequences return the committed cumulative session value and never
renew a lease, alter a baseline or credit twice. Skipped sequences are allowed;
late lower sequences remain suppressed. Valid client elapsed is finite 0..20
seconds. Credit is `min(client_elapsed, positive_server_gap, 20)` only while the
same unexpired activity lease was already held, the previous and current accepted
states are visible, the server gap is at most 30 seconds, and any player binding
still owns playback. Client timestamps/durations cannot replace server time.

Waiting tabs, expired-lease recovery and hidden-to-visible return establish a fresh
zero-credit baseline before credit can resume. This deliberately prevents the
legacy waiting-tab overlap bug. Long gaps suppress the missing interval. Backward
clock movement credits zero and never moves the accepted baseline backwards.
`visible=false` releases only this session's activity lease and keeps the session
open; `ended=true` closes permanently, releases ownership and may credit the final
visible interval if otherwise eligible. Detailed sessions expire after six hours;
an expired/closed session cannot reclaim ownership. Current leases are renewed
only by newly accepted visible, eligible heartbeats.

Optional `player_session_id` refers to the current Go `playback_sessions` ID,
never to a media token. The player must match learner, auth session and lesson,
be open/unexpired and currently own the playback lease. Unknown/cross-scope links
return 404; correctly scoped inactive links return 409 on open. Every accepted
bound heartbeat rechecks that ownership; it never claims or renews playback.
Native takeover permanently closes linked activity sessions and clears their
activity leases in the same SQL transaction. Playback hidden/release removes the
linked activity lease and visible baseline; deliberate player reclaim must first
establish a new activity baseline. Deleting a retained player never converts a
bound activity session into an unbound live session. Unbound page activity works
for embedded/fallback lessons under its independent exclusive activity lease.

## API and security

| Route | Request and response |
| --- | --- |
| POST `/api/v1/lessons/{id}/activity-session` | JSON object, optional `player_session_id`, optional `visible` (default true); 201 `id`, `activity_seconds=0`, `sequence=0`, `owner`, `basis`, `server_now` |
| POST `/api/v1/activity/{id}/heartbeat` | Required `sequence`, `visible`, `elapsed_seconds`; optional `ended` default false; 200 cumulative `activity_seconds`, acknowledged `sequence`, `accepted`, `owner`, `closed`, optional `reason`, `basis`, `server_now` |
| GET `/api/v1/me/learning` | `limit` 1..100 default 30, bounded tuple `cursor`; private summary, course page and `next_cursor` |

Every route requires current verified/unsuspended account and live authentication.
Mutations require existing identity middleware's same-origin CSRF and bounded
16 KiB JSON. Activity sessions are bound to the exact login session, even for the
same learner on another device. Current publication/enrollment is locked before
every response, including duplicate/closed heartbeats; administrators retain the
existing current-course access exception. Cross-user, auth-session and inaccessible
lesson references return common structured 404. Auth/session revocation returns
401; unverified/CSRF/origin failures 403; malformed JSON 400; invalid bounded fields
422; open rate admission 429 with Retry-After; database failures 503.

Session opens retain the legacy fleet-wide bound of 90 per learner per 60 seconds.
Open itself is not an idempotent command: allocate a fresh session per explicit
page open. Credit-bearing heartbeat retries use the same session and sequence;
no per-heartbeat event table or command snapshot is introduced. Invalid or denied
requests persist no activity, last visit or lease changes. Server time is injected
only by a test/service clock, never from the HTTP body. Mutations serialize on the
learner row using the same lock order as native playback, then access/source rows,
before session/lease work; no provider/model/network call occurs in a transaction.

## Summary and lifetime projection

`lesson_activity_totals` is the only authoritative visible-page lifetime aggregate.
Accepted positive activity deltas increment it in the same transaction as sequence
and lease state. **Never add or project `playback_sessions.visible_seconds` into
this aggregate.** That existing field remains native pulse diagnostics. Native
`playback_totals.watched_seconds` remains the separate accepted wall playback time
(the legacy `playing_seconds` concept), not coverage length. Focus is independently
computed from server-capped focus timer state, excluding breaks/canceled sessions.

The summary returns global private lifetime `activity_seconds`, `watched_seconds`
and `measured_focus_seconds` as distinct fields, plus
`time_basis='visible_lesson_activity'`, `completion_basis='learner_or_playback'`,
`server_now` and disclaimer. Lifetime activity/watched totals include the learner's
historical stored lessons regardless of current enrollment, matching legacy
activity totals; inaccessible titles/IDs never appear in course content.

Course rows include only the caller's currently enrolled, published courses with
at least one lesson (including for administrators, matching `my_learning`). Each
has `course_id`, metadata (`title`, description/instructor/category/tags/slug),
`created_at` enrollment instant, all-status `lessons`, `completed`, independent
course activity/watched totals, `last_lesson_id`, `last_opened`. Last visit comes
from explicit activity open, not from progress writes, watch-history updates or
retained session sorting. Course ordering is last visit descending (null last),
enrollment time descending, stable ID descending. Cursor contains that tuple and
is bounded; page membership can change when courses receive new visits. Summary
queries use a coherent SQL transaction snapshot; totals do not depend on page size.
No emails, device/IP, auth/player capabilities, answers or other learners' rows
are returned. The counts/projections must not multiply through joins.

## Retention, migration and integration

Detail reports retain legacy session ID, owner, login binding, lesson, sequence,
heartbeat/creation time, seconds, device/IP, close state and optional player link.
Authenticated-session deletion does not delete detail reports. Account deletion
cascades sessions, totals, visits and admission counters. Course/lesson deletion
follows existing catalog retention; deleted lesson references cannot reappear as
unbound live activity. Visits retain the course timestamp with a null last lesson
if that lesson is removed. Detailed sessions are eligible for cleanup after 90
days; deleting them cannot reduce lifetime activity totals or change last visits.
Cleanup is a bounded SQL-only operation for root's future retention worker; it
does not run automatically or alter shared staging from this slice.

Migration 011 provides `activity_sessions`, `activity_leases`,
`lesson_activity_totals`, `lesson_visits` and activity-open admission state, plus
transaction-local playback lifecycle triggers. Import legacy lifetime activity
totals directly and independently from detail sessions; never sum retained
sessions onto an already cumulative aggregate. Preserve last visits independently.
Map legacy `video_id` to `lesson_id`, `course` to `course_id`, numeric heartbeat
epochs to UTC timestamps, old player IDs only through validated mapping. Retain
binding provenance, close all imported live activity and invalidate leases at the
write freeze. Native visible diagnostics are not an alternative import source.
No importer or migration execution is claimed by this schema seam.

Frontend integration remains future work: open activity once per current lesson
generation after optional playback ownership is established; pulse about every
15 seconds with a single ordered queue, retry identical sequences, report only
continuously visible elapsed time, send immediate hidden and final ended events,
stop on terminal authentication/access failures, and reopen explicitly after expiry.
Do not run two activity transports or add native visible time to page totals.
Root integrates API/OpenAPI/retention jobs. Browser flows, administrator activity
reports/exports, semantic import and crash/restart durability rehearsal remain
separate gates. Tests use disposable PostgreSQL and real public HTTP APIs; they
establish no concurrent-learner or media/AI capacity.
