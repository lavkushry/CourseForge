# P1 Step 9: focus sessions and weekly time analytics

## Scope

- Server-timed focus and break sessions with pause, resume, finish and discard.
- Source-linked focus context: a daily plan item, an indexed lesson, or a curated lab session. No file paths or arbitrary execution inputs are submitted.
- Persisted UTC start/end intervals and a hard per-session cap (1–120 minutes).
- Weekly Monday–Sunday comparison of planned, manually reported and timer-measured minutes; measured time is distributed by local calendar date using the browser's timezone offset.
- Pomodoro-style controls, session history and day-by-day chart in **Today’s plan**. Opening a lesson/lab offers an explicit route to focus with that context.

## Endpoints

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/focus/sessions` | Start `{mode, duration_minutes, planner_item_id?, video_id?, lab_session_id?, title?}` |
| POST | `/api/focus/sessions/{id}/actions` | `{action:pause|resume|finish|cancel}` |
| GET | `/api/focus/active` | Current running/most-recent paused timer |
| GET | `/api/focus/history?limit=30` | Persisted sessions with bounded elapsed time |
| GET | `/api/focus/analytics/{monday}?tz_offset_minutes=-330` | Daily/weekly totals; JS `getTimezoneOffset` convention |

No client-submitted elapsed values are accepted. All state-changing calls inherit the existing loopback origin guard. Running sessions are automatically capped at the configured target even if the client disappears. Only one timer can run at a time. Paused intervals never contribute to measured time. Break sessions and discarded sessions never contribute to study totals.

## Semantics

- **Measured:** Server wall-clock time between explicit start/resume and pause/finish, capped by timer duration. Not proof that the learner was attentive or typing.
- **Self-reported:** Existing `daily_plan_items.actual_minutes` values. These are not overwritten or added to measured time.
- **Planned:** Existing daily plan-item estimates. Zero when no daily schedule exists.
- **Consistency:** Count of local calendar days with at least 60 seconds measured focus time in the chosen week.
- **Mastery:** Unaffected. A timer cannot grade a lab, complete a lesson, or certify understanding.

Analytics split intervals spanning midnight into the corresponding local days. Break minutes are excluded. Study time is not silently merged with existing reported minutes, which would double-count work.

## Reliability and safety limitations

This is a **local single-user prototype** without account authentication. Keep FastAPI restricted to loopback. No background/OS-level activity verification is implemented. `visibilitychange` triggers a best-effort pause when the browser tab becomes hidden, but browser termination/network failure may prevent that call. The timer then runs only until the configured session cap; on the next API interaction the server reconciles its final timestamp. Moving between tabs or applications, or leaving the browser active while distracted, may still count as focus time. The UI must not claim verified attentiveness.

Focus data is saved in the same local SQLite database and should be included in backups. The timer uses the server clock rather than client timestamps, limiting accidental device clock manipulation, and the unique running-session index prevents overlap. User-supplied titles are rendered as text, not HTML.

## Verification

```bash
python -m pytest -q
python -m compileall -q app scripts
node --check app/static/focus.js
```

The new tests cover pause/resume, hard cap, breaks, cancelled sessions, invalid IDs, local-time midnight boundaries, independent manual-time accounting, origin enforcement and UI element contracts. CI must also test the new browser script syntax. Interactive Chromium verification and actual focus behavior on the learner's Mac remain separate acceptance steps.
