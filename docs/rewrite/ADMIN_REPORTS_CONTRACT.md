# Administrator learning and activity reports contract

Written 2026-10-12 before implementation. Sources are explicitly allowlisted:
`app/academy.py` overview/users/detail and cleanup, `app/admin_console.py` activity
report/CSV/system, `app/native_player.py` playback reports/CSV, corresponding SQL
migrations, and `app/static/academy.js` administrator screens. No private database,
provider manifest, environment file or credentials is used as a test fixture.

## Access, snapshots and accounting

All routes require a current verified, unsuspended administrator and a live login.
Guest/revoked login returns 401; students/unverified accounts return 403. Current
role/account/login validity is rechecked under SQL locks in each coherent report
transaction. Report access is explicitly administrative across learners and courses;
learner predicates in per-user projections are mandatory. Missing learner returns
404. Database errors return structured 503 without SQL or internal details. Responses
are private/no-store, including CSV/errors. Account management, invitations, course
controls and existing `/admin/users` identity routes are not duplicated.

Page activity, accepted wall playback time, watched coverage, focus timer time,
completion and assessment outcomes remain distinct. Activity lifetime comes only
from `lesson_activity_totals`; never add native `visible_seconds`. Watched lifetime
comes from `playback_totals`; retained session sums describe only the selected detail
period. Focus includes only focus-mode non-canceled sessions, with running elapsed
bounded by configured duration and positive server time. No time establishes
attention or mastery. Completion is explicit learner or validated playback completion.

A live activity page requires open/unexpired activity, an unexpired matching activity
lease, a verified/unsuspended learner, a live matching login, current publication/
enrollment (admin exception), and any bound player's current open/unexpired lease.
A retained bound player set to NULL never becomes an unbound live activity page.
Live playback requires open/unexpired native session and lease, accepted playing and
visible baseline, live matching login, learner status and current course access.
Live page activity never means the video is playing. Historical admin records remain
inspectable after enrollment removal/unpublication; live flags become false.

## Routes and bounds

All paths below are under `/api/v1/admin`.

| Route | Behavior |
| --- | --- |
| GET `/overview` | Independent lifetime/count projections, bounded recent activity/detail records and course enrollment/visit funnels. Recent lesson-page rows are explicitly activity sessions, not invented learning events. |
| GET `/course-funnels` | Stable paginated course enrollment and explicit-last-visit counts; follows the bounded overview funnel cursor. |
| GET `/learner-reports` | All account roles, literal bounded name/email search `q`, per-user enrollment/completion/page/watch/focus/note counts and last login activity; stable created-at/ID cursor page. |
| GET `/users/{id}/learning-report` | One learner's private aggregate report, account metadata, separate time/count fields and explicit available/unavailable detail sections. No note text, answers, tokens or password hashes. |
| GET `/users/{id}/reports/{section}` | Bounded stable timestamp/ID pagination over `enrollments`, `progress`, `visits`, `activity`, `playback`, `quizzes`, `assessments`, `reviews`, `plans`, `focus`, `sessions`, `access`, `activity-sessions`, `player-sessions`. `events`/`labs` return explicit 503 until real adapters/storage exist; unknown section 404. |
| GET `/player-activity` | Retained visible-page detail sessions, full filtered count/distinct learners/lessons/detail seconds and stable last-heartbeat/ID cursor page. |
| GET `/playback` | Retained native session detail, full filtered count/learners/lessons/watched detail seconds; separate visible diagnostic seconds; stable created-at/ID cursor page. |
| GET `/player-activity/export` | Same filtered detail scope, safe bounded CSV, audit and shared SQL export admission. |
| GET `/playback/export` | Same filtered detail scope and protections. |
| GET `/audit` | Bounded administrative audit metadata, stable created-at/ID cursor page. |
| GET `/access-events` | Bounded access metadata, optional exact learner scope; absent legacy device/IP fields explicitly unavailable rather than fabricated. |
| GET `/system` | Actual SQL job counts, course/provider-mapping counts, pending invitations, bounded audit, configured capability flags and truthful retention policy/execution status. No provider URLs/IDs/credentials, service checks or analytics fabricated. |

Report pagination is `limit=1..100`, default 25, plus a URL-safe opaque cursor
bounded to 1,000 characters containing an immutable sort timestamp and stable ID.
Search `q` is a literal substring of name/email/lesson title, maximum 120 characters;
SQL parameters prevent SQL injection and `%`/`_` are not wildcard operators.
Activity/playback filters are `days=1..90` default 30, optional exact `course_id`
(max512), optional `user_id` (max512), and `status=all|live`. Detail period includes
sessions created on/after server-now minus days, independently of lifetime totals.
Counts and totals ignore page cursor/limit and share the same transaction snapshot.
A new session/page change may change subsequent page membership; no false frozen
report guarantee is made. Invalid bounded query fields/cursors return 400.

CSV is synchronous SQL-only, capped at 10,000 rows and 16 MiB encoded output. Larger
matches/output return 413 and a specific instruction to narrow filters. No queue job
or partial file is returned. Exports may not accept a cursor or page limit and always
use the complete filtered set up to the cap. Both export kinds share 10 successful
exports per administrator per hour across instances via a namespaced existing SQL
admission row. Exhaustion returns429 with Retry-After. Successful snapshot, admission
and audit commit together before bytes are returned. Invalid/oversized/failed requests
commit no export audit or quota consumption. No database connection remains held
while HTTP bytes are delivered.
Each explicit JSON detail projection is capped at 64 KiB; oversized stored fields
return 413 without truncation. SQL text-byte lower bounds reject known oversized CSV
sets before materializing them; actual encoded bytes remain separately capped.
Report transactions have a five-second request budget. Concurrent export snapshot
conflicts retry only the entire uncommitted transaction, with jitter, at most 16
attempts under the same deadline; exhaustion is a retryable503, not a false success.

CSV quoting uses encoding/csv. Every text cell whose first non-whitespace character
is `=`, `+`, `-`, `@`, or whose prefix contains tab/CR/LF, receives an apostrophe to
prevent spreadsheet formula interpretation; quoting alone is insufficient. Numeric
and boolean fields are generated server-side, not copied from arbitrary user strings.
Response headers use fixed attachment filenames, no-store and nosniff. CSV contains
administrator-visible learner name/email, lecture/course ID, independent session
seconds/state/timestamps; activity includes retained device/IP, playback reports
current login device/IP availability without claiming immutable per-player snapshots.
It contains no auth/player IDs usable as capabilities, hashes, CSRF or provider data.

## Retention and unavailable semantics

Legacy policy is access events 30 days, detailed sessions 90 days, audit 90 days; lifetime
learning totals remain until account/catalog deletion. This module reports policy
separately from scheduler execution. It does not run retention or claim that deletion
is scheduled. Root must wire/rehearse bounded retention after defining all lifecycle
rules. Detail account/login snapshots and access IP/device legacy fields may need
future migration/schema work; this slice does not silently invent them.
Native session detail currently has a cascading login foreign key: deleting its
login removes that native detail before the nominal 90-day policy, although lifetime
watched totals remain. Activity detail survives login cleanup with a closed binding.
System/retention metadata must disclose this native-login dependency until a future
schema preserves closed native records and safe device/IP snapshots.

Legacy engagement/teacher AI insights, learning-event chronology, lab results,
streaming interaction analytics, external service health checks and provider mapping
refresh are not reconstructible from existing SQL here. Their unavailable state is
explicit in overview/system/per-user capabilities. Root owns their real adapters and
full parity acceptance. A provider-configured flag is injected as optional metadata;
unknown configuration is null, never falsely reported missing/healthy. No provider
network calls or model execution occur in report transactions.

Verification uses disposable PostgreSQL plus registered public HTTP handlers and
race checks. Test current role/session revocation, cross-role denial, independent
per-user counts, joined-count multiplication, current live predicates, historical
scope, literal search, cursor bounds/ties, actual CSV formula cells, row/byte admission,
quota sharing and audit atomicity. Browser admin UI, typed legacy import/recovery,
large queued exports and 10,000-learner cost remain separate unproven gates.
