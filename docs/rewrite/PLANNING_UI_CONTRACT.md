# Planning UI restoration contract

The TypeScript planning panel restores the Python daily and weekly planners,
focus timer and habit settings through existing authenticated Go endpoints.
The coordinator owns mounting this panel in the premium application shell.

- Daily: choose a date and owned learning path; save a 15–180 minute budget;
  explicitly build or refresh, preserving server revisions; open a real source,
  start linked focus, set pending/done/skipped and log 0–600 reported minutes.
- Weekly: previous/next week, normalized Monday date, seven individual budgets
  (rest 0, otherwise 15–180), explicit build/refresh, forecast reviews and open
  a saved daily plan. Planned, reported and measured time remain distinct.
- Focus: independent or source-linked focus/break sessions, 1–120 minutes;
  start/pause/resume/finish/cancel, restore the server's active session on opening,
  periodic synchronization, paginated history and weekly measured analytics.
  A monotonic browser countdown animates a server snapshot; it never awards time.
  Hidden-tab pause is best effort and errors stay visible; no automatic resume.
- Habits: server accepted playback, lesson, quiz and explicit review-completion
  counts; goal, initially selectable then anchored read-only timezone, streak and seven-day totals; reminder preference can be
  stored but delivery remains explicitly unavailable when server says so.
- Recall insights: actual due cards, history and weak self-rated recall areas;
  never relabel the server's recall signal as assessed mastery.

Responses are validated at runtime. Writes carry stable command keys across an
uncertain retry; changed bodies create new keys. Revision conflicts require a
reload rather than blind overwrite. Account/navigation disposal aborts requests,
clears private DOM and in-memory commands, and prevents stale completions. No
provider credential, local learner data or API body is logged.

Verification uses synthetic browser fixtures first. Actual Go tests must use a
fresh explicitly isolated database/origin: port 15439 now holds production data
and must not receive synthetic writes. Production approval, capacity and provider
playback are separate gates.
