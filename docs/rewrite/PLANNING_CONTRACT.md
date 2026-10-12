# Planning, focus and habits contract

This contract covers the legacy planner/weekly/focus/habits/studio behavior. It is
an implementation contract, not capacity or full-parity evidence.

## Identity and time

Every route uses current verified account/session authentication; mutations also
require same-origin CSRF and an Idempotency-Key (1..128 characters). Command keys
are learner private, compare the normalized command, and retain a durable response
snapshot. Wrong-key reuse is 409. Referenced lessons/courses must be currently
published/enrolled, or accessible to an administrator. Historical inaccessible
items stay stored for import/retention but are omitted from content responses.

The anchored IANA timezone is shared with `learning_preferences`: first accepted
selection/action wins, default UTC. Browser offsets cannot change a learning day.
Calendar dates are YYYY-MM-DD; weeks start Monday. Server clock/UTC timestamps
define focus intervals; the client cannot submit elapsed seconds or timestamps.
Daily credit and interval attribution use real timezone boundaries, including
23/25-hour DST days. Production binaries embed timezone data.

## Public API

All routes below use `/api/v1`. Error bodies use the common structured error.
Lists have stable tuple cursors and limit 1..100. JSON bodies are bounded 16KiB.

| Routes | Commands / behavior |
| --- | --- |
| GET/PUT `/planner/preferences` | daily_minutes 15..180 (default 45), optional path_id; versioned changes with expected_revision (0 for first save) |
| GET/PUT `/planner/week-preferences` | exactly seven weekday_minutes, each 0 or 15..180, at least one study day; expected_revision |
| GET `/planner/days/{study_date}`; POST `/planner/days` | Create/get source-backed deterministic plan; body study_date, refresh(defaultfalse), expected_revision required for refresh (0 if new). No refresh preserves the existing plan. |
| PUT `/planner/items/{id}` | status pending/done/skipped, expected_revision; checklist state never changes mastery/quiz/lab results |
| PUT `/planner/items/{id}/actual` | actual_minutes 0..600, expected_revision; explicitly self-reported time |
| GET `/planner/weeks/{week_start}`; POST `/planner/weeks` | Generate seven-day snapshot using weekday budgets; body week_start, refresh, expected_revision. Preserve recorded work/rest-day history. Review cards are allocated on/after their due local day; no scheduling early. |
| POST `/focus/sessions` | mode focus/break; duration_minutes 1..120 (default 25); title ≤160; at most one planner_item_id, lesson_id, lab_session_id |
| POST `/focus/sessions/{id}/actions` | action pause/resume/finish/cancel/hidden, expected_revision; hidden is pause; no elapsed input |
| GET `/focus/active`; GET `/focus/history` | Current/private sessions; one running timer per learner across replicas; history cursor/limit |
| GET `/focus/analytics/{week_start}` | Seven anchored-local days, measured focus seconds, self-reported minutes, planned minutes kept separate; breaks/canceled timers excluded from focus analytics |
| GET `/me/habits`; PUT `/me/habit-preferences` | goal minutes/lesson, timezone, reminder_email; timezone remains anchored; sticky achieved days, current/best streak and last-seven-day sums |
| GET `/studio/insights` | Private due/review/recall signal and activity summaries; self-rated recall is not inferred certification or mastery |

Daily plans prioritize bounded due reviews, then eligible incomplete source-backed
lessons. Estimates are suggestions. Refresh preserves IDs, action snapshots,
statuses and actual reports for recorded/focus-linked items. Newly proposed work
fits the remaining budget, with at most 32 retained items/day and 6 new suggestions.
Weeks reserve suggested source items across study days and preserve recorded
history when budgets change. Forecast counts include all eligible cards; embedded
card IDs are bounded 100/day.

Path and lab references use injected SQL-only adapters that verify current learner
ownership and course scope. With no adapter, supplied path/lab links fail 503;
unverified arbitrary IDs are never accepted. These modules remain a separate parity
gate. The fallback planner works from published/enrolled indexed lessons/reviews.

## Focus accounting

Persist running intervals and cumulative closed seconds. Pause/hidden closes the
interval at server time; resume opens a new interval. A configured target caps
total time, including forgotten/offline timers, at its exact exhaustion instant.
Reconciliation closes exhausted timers before another start/action. Pause time is
excluded. At most32 open sessions and 256 intervals/session bound resource growth;
old terminal sessions stay available through pagination. Every write locks current
identity/access and serializes that learner's planning/focus state across replicas.

Measured focus time is timer wall-clock time, not proof of attention. It does not
credit watched-video minutes, completion, review, quiz or mastery. Self-reported
planner time, visible page seconds, played/watched seconds and focus seconds are
distinct response fields and may never be added together as a learning total.

## Accepted-action habit credit

Migration007 adds transaction-local SQL projection triggers: newly accepted
`learning_credits` feed quiz/review counts; progress completion transitions feed
duplicate-safe lesson/day actions; positive playback-session watched deltas feed
watched seconds split at anchored local midnight. Root's durable pulse sequence
already suppresses duplicates. No per-pulse habit-event table is introduced.
Trigger work is bounded by the 20-second accepted-watch delta, without provider IO.
Goals are 900 watched seconds (minutes) or one accepted lesson/quiz/review action.
Achieved days stay achieved when preferences change. A changed goal may achieve
today based on already accepted actions.

Historical watch totals cannot establish when viewing occurred. Migration imports
the preserved legacy habit-day/action rows and focus interval timestamps; it must
avoid replaying projection triggers over already restored aggregates. IDs,
ownership, source references, ordering, statuses, timestamps, explicit reports and
interval provenance remain importable. Historical timezone offsets are retained as
provenance while new plans use the anchored IANA zone.

## Evidence and remaining gates

Use disposable PostgreSQL schemas with two learners/admin and current identity
middleware. Prove cross-user/reference denials, bad CSRF/origin, duplicate commands,
concurrent start/resume/revision races, pause/hidden/restart snapshots, bounded
expiry, no client time invention, midnight/DST splitting, anchored timezone,
stable refresh IDs/history, weekly rest/forecast rules, and distinct time metrics.

SMTP reminders, administrator engagement reports, page-activity transport, generated
path/practice/lab suggestions, browser flows and semantic migration/restart proofs
remain separate gates until implemented and measured. Opt-in storage does not
claim reminder delivery. This slice does not establish 10k capacity.
