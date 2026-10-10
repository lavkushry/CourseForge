# CourseForge P1.7 — Personalized Daily Learning Planner

## Scope

This local-first feature schedules a **single day** from real data, with a persisted daily checklist and a time budget. It does not infer study-time measurements or award certification. It uses deterministic rules without requiring an LLM request.

**Signals:** due `review_cards`, incomplete source-backed video lessons, unlocked prerequisite path steps, latest scored mastery assessments, and ranked curated lab recommendations. No AI-generated commands run from the planner.

### Planning policy

1. The browser sends the selected local date and JavaScript timezone offset; the server computes the end-of-day UTC cutoff for due reviews. DST transitions near midnight may require an updated plan; replan if the offset changes.
2. Due flashcards take priority. The planner picks up to 20 due cards (bounded estimate); actual flashcard grading stays in Review.
3. A selected cross-course roadmap gates content by completed prerequisites; stale path content yields a warning and no new path-linked suggestions.
4. Next are focused source-linked lessons (timestamps are preserved), relevant curated labs, and concept checks. Each task has an **estimated** duration. The total scheduled minutes never exceed the selected daily budget.
5. Without a path, CourseForge can schedule indexed incomplete video lectures and due flashcards. With no imported/indexed content it displays an actionable empty state.
6. Plan checklist entries are **self-reported**. Marking a lab "done" never marks the lab as passed, marking a review "done" never grades flashcards, and marking a lesson "done" never updates video progress or topic mastery.
7. Regenerating a day preserves status for the same item and unchanged action. If a review's due-card set changes, it resets the self-reported status.

### API endpoints

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/planner/preferences` | Retrieve saved daily budget and preferred roadmap |
| `PUT` | `/api/planner/preferences` | Set budget 15–180 minutes and an existing path ID (optional) |
| `GET` | `/api/planner/days/{YYYY-MM-DD}` | Read an existing plan; does not mutate |
| `POST` | `/api/planner/days` | Generate a day; `refresh=true` replans with current sources |
| `PUT` | `/api/planner/items/{id}` | Update planner-only `pending`, `done`, or `skipped` status |

Example generation:

```bash
curl -fsS -X POST http://127.0.0.1:8000/api/planner/days \
  -H 'Content-Type: application/json' \
  -d '{"study_date":"2026-10-10","tz_offset_minutes":-330,"refresh":true}'
```

The browser automatically uses the computer's local date and timezone. The API does not assume the server timezone.

### Storage

- `planner_preferences`: single-user daily budget + selected path.
- `daily_plans`: local date, budget, path ID, timezone offset and timestamps.
- `daily_plan_items`: source-linked task actions, estimated minutes, item keys and self-reported status.

Tables are created by the idempotent `init_db` upgrade path. Existing course videos, transcript vectors, path completions, review cards and lab attempts remain untouched.

### Tests and safety

`pytest -q` covers budgets, due-date timezone boundaries, source timestamp fidelity, prerequisite locks, obsolete syllabus warnings, data persistence, API validation, and separation of self-reports from verified outcomes. `node --check app/static/planner.js` is part of GitHub Actions CI.

CourseForge still requires a real-device end-to-end pass with the learner's Ollama/Qdrant/Docker environment. Browser-level live acceptance cannot be claimed from environments where Chromium navigation is blocked. Run the app on `127.0.0.1`, open **Today’s plan**, select a roadmap and duration, create the plan, open the source lecture, and confirm the checklist persists after refresh.

### Next evolution

A week-view scheduler, review workload forecasting, learner-adjusted duration estimates, optional reminders, timezone-zone support across DST, and explicit conflict detection for stale plan actions are useful future improvements. The current release does **not** pretend to implement these.
