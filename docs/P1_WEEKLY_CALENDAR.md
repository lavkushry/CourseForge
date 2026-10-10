# P1 Step 8 — Seven-day adaptive learning calendar

## Delivery

A weekly calendar extends the v3 daily planner without moving, uploading, or duplicating local course videos. Choose per-weekday budgets (0 rest, 15–180 minutes on study days). The planner proposes source-backed lessons, assessments, curated labs, and cards due for review; click a day to open its saved checklist. Recorded study minutes are explicit **learner reports**, not measured playback duration.

## Data model

- `weekly_preferences`: seven minute budgets, Monday through Sunday, saved in SQLite.
- `weekly_plans`: start Monday, timezone offset, snapshot budgets, review forecast, selected path, unscheduled due cards, generation timestamps.
- `daily_plans` and `daily_plan_items`: the existing durable daily planner. New `actual_minutes` column (default 0) is added through an idempotent migration. `status` continues to mean *self-reported checklist completion*, not quiz/lab competency.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| GET / PUT | `/api/planner/week-preferences` | Read or store seven weekday minute budgets |
| GET | `/api/planner/weeks/{week_start}` | Retrieve a stored week; requires a Monday |
| POST | `/api/planner/weeks` | Generate/refresh `{week_start, tz_offset_minutes, refresh}` |
| PUT | `/api/planner/items/{item_id}/actual` | Explicit self-reported `{actual_minutes}` (0–600) |

The existing daily planner endpoints remain compatible. Both week and daily plans are stored locally. All mutations still use FastAPI's local Origin guard.

## Scheduling rules

1. Cards with stored `due_at` timestamps are converted from UTC to the local calendar date using the provided JavaScript timezone offset. Overdue cards move to the earliest available study day; cards due on rest days move forward to the next study day **but never earlier than their due date**. Cards beyond the last study day are shown as unscheduled rather than silently scheduled early.
2. Course lessons, checks, and labs are drawn from the existing local planner, which respects prerequisite locks and never invents videos, scores, or lab results.
3. A weekly run avoids repeating the same pending learning task across multiple days. The 15–180-minute per-day budget is enforced for newly selected tasks.
4. Refreshes retain already completed, skipped, or time-recorded items, including their IDs and actual minutes. If the historic recorded work exceeds a newly reduced budget, that work remains intact and the calendar may show the over-budget total. Existing daily plans are kept when generating a new week without refresh.
5. Forecasts are snapshots. Grading flashcards can shift their actual due dates; rebuild the calendar to update the estimate. Time zones are represented by a *fixed offset* supplied at generation; daylight-saving transitions need additional work for region-aware multi-day offset handling.

## Acceptance

```bash
python -m pytest -q
python -m compileall -q app scripts
node --check app/static/planner.js
node --check app/static/weekly.js
```

Start FastAPI and open `http://127.0.0.1:8000/#planner`. Change budgets (including rest days), click **Build / refresh week**, open a day, and enter *Actual minutes*. Reload to confirm the recorded figures persist. The app requires a browser connected to the local FastAPI instance. CI validates the API and static frontend contract; it does not prove browser interaction against your real videos, Ollama, or Docker installation.
