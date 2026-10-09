# P1 Step 6 — Adaptive practice recommendations

## Delivered

CourseForge links topic-level MCQ assessment signals to the eight existing **curated** lab tracks, without executing generated code or inventing learner mastery. A curated taxonomy matches the topic title and objectives to an appropriate local exercise. This is a heuristic; unmatched topics are left unmatched rather than inventing labs.

The Learning → Study Paths view now shows recommended labs under matching topics. The Labs view displays prioritized recommendations for a selected saved learning path, and a timeline of real graded attempts. An attempt is associated with the learning path only if the learner starts the exercise from one of those targeted recommendations.

## Ranking and states

- Latest assessment score below 70%: prioritize targeted practice.
- 70–84%: recommend fluency-building labs, with lower priority.
- 85% or higher: no weak-concept recommendation unless a linked lab has an attempt requiring follow-up.
- Unassessed topic: show a relevant curated lab as an optional choice, explicitly recommend assessment first.
- Failed restricted grader: elevate retry priority; preserve earlier failures.
- Passed restricted grader: recommend reassessing the topic, not automatic mastery. A verified pass remains separate from watched-video progress, manual path completion and quiz scores.

Ranking uses only saved local assessment and grader results. It doesn't use AI-invented scores, imported ratings or course-level certificates. No Dockerfile or Ansible playbook is executed: their configured graders perform static checks.

## Schema and API

The migration runs via `init_db()` and preserves all existing v2 and v3 data:

- `practice_sessions` links `(session_id, path_id, step_id, lab_slug)` for explicitly chosen guided practice.
- `practice_attempts` contains append-only grader output summaries with passed status and check counts; no runnable source code is copied into the history table.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/learning-paths/{id}/practice-recommendations` | Prioritized curated lab matches and source evidence |
| GET | `/api/learning-paths/{id}/practice-history?step_id=...` | Last 100 recorded linked grader attempts |
| POST | `/api/learning-paths/{id}/steps/{step}/practice/{slug}/start` | Validate match and start a path-linked lab session |
| POST | `/api/lab-sessions/{session}/submit` | Existing restricted grader; append a practice attempt only after it returns successfully |

`GET /api/learning-paths/{id}` additionally exposes `lab_attempts`, `topics_with_passed_labs` and per-step `practice` attempts. No existing route is removed.

## Data integrity and safety

- Manual path completion and quiz results are never overwritten by a lab pass.
- A linked start rejects unrelated exercises or an outdated source syllabus. Recommendations still display a warning when outdated.
- An unlinked lab session retains the original standalone grading behavior.
- A grade result is recorded only when the restricted grader returns a nonempty, correctly typed check list. Errors and timeouts do not count as passes.
- Source timestamps remain part of the existing roadmap topic links; recommendations never invent new video IDs.
- The local app is single-user and loopback-bound with no authentication. Do not expose these APIs publicly.
- A curated lab is only as reliable as its trusted grader and test coverage. PySpark image execution still needs validation on the destination computer.

## Test and manually inspect

```sh
python -m pytest -q
python -m compileall -q app scripts
node --check app/static/app.js
node --check app/static/learning-paths.js
node --check app/static/practice.js
```

With a populated library, go to Learning → Study Paths, generate a topic assessment and answer it. A weak topic will offer a matching lab below the topic. Start the lab, save your answer, and run checks. Visit Labs → Recommended next labs to inspect the saved pass/fail history, return to the topic, and take another assessment. The lab pass must **not** automatically mark the topic complete.

For real Docker validation on your Mac, build the grader image(s), then run `python scripts/lab_smoke.py --spark` as documented in `docs/P1_LAB_TRACKS.md`. The automated API tests mock Docker; they cannot establish real runtime isolation on your Mac.
