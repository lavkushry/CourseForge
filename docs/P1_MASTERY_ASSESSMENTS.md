# P1 Step 4 — Topic-level mastery checks

## Behavior

CourseForge generates 3–5 multiple-choice questions from **real indexed transcript and screen chunks** near a selected cross-course study-path topic. Generation uses the configured local Ollama chat model. The source evidence is treated as data, not a command. Questions are explicitly described as AI-generated practice; they may be mistaken and do not establish mastery or certification.

A learner opens **Learning → Study paths**, selects an existing roadmap and clicks **Assess this topic**. The answer key is kept in SQLite and omitted from all question-loading responses. The browser submits numeric choice IDs. The server grades deterministically and returns individual explanations, correct answers and clickable lecture timestamp references for missed questions. Repeating the check updates a per-topic practice signal and attempt count. Roadmap completion stays an intentional, separate action.

### Scoring labels

| Score on last attempt | Label | Meaning |
|---|---|---|
| Under 70% | Needs practice | Revisit missed source excerpts |
| 70–84% | Developing | Try more practice and verify sources |
| 85–100% | Ready for review | Demonstrated recall on this short AI-authored check; not proof of mastery |

This is a small practice sample, not psychometrically validated. Scores cannot be compared to Coursera/Udemy qualifications. For 3-question sets, each item is worth approximately 33.3%; review labels are coarse by design.

## API

- `POST /api/learning-paths/{path_id}/steps/{step_id}/assessments` — `{"count":3}` generates and persists source-grounded questions, returning question IDs, stems, four choices, and video reference information **without the answer key**. Requires indexed excerpts near this step and a current saved path. Ollama unavailable: HTTP 503.
- `GET /api/assessments/{assessment_id}` — returns the same sanitized questions, e.g. for refreshing the page.
- `POST /api/assessments/{assessment_id}/attempts` — `{"answers":{"q_UUID":0,"q_UUID2":3,"q_UUID3":1}}`. Requires all answers, validates indices, grades server-side and saves an attempt. Returns score, feedback, rationale, and remedial video timestamps. Stale source: HTTP 409.
- `GET /api/learning-paths/{path_id}/assessment-history?step_id=...` — last 100 attempt summaries (no raw answers or answer keys).
- `GET /api/learning-paths/{path_id}` — each step includes `mastery` as an optional **assessment signal**; path includes `assessed_topics` and `topics_needing_practice`.

## Data model

`topic_assessments` stores an immutable assessment record and SHA-256 fingerprint of both source excerpts and the originating path. `topic_assessment_attempts` stores timestamped answers and numeric scores. Foreign keys cascade on path deletion. The schema is created automatically during existing `init_db` and does not migrate or drop original v2 tables.

Only indexed excerpts belonging to the selected path step and matching course identity are used. The model must return valid JSON with 4 distinct nonblank options, an unambiguous `correct_index`, and an existing `source_index`. Malformed output is rejected; there is no fake or hard-coded substitute if the model fails. Model explanations can still be wrong even with valid JSON. The UI provides source links so the learner can verify them.

## Quality gates

Run `pytest -q`, `python -m compileall -q app scripts`, and Node syntax checks for `app.js`, `services.js`, `learning-paths.js`, and `assessments.js`. Tests cover answer-key privacy, score calculation, source provenance, invalid AI output, path/lecture staleness, missing videos, persistent mastery summaries, API validation, CSRF origin rejection, and the frontend control contract. Browser smoke should validate click, answer, feedback, source seek and mobile layout.

**Real local-model validation still required:** Run a short indexed course with the Ollama chat model active, build a roadmap, generate a check, verify each question and the stated correct answer against its cited lecture, submit it, and follow one remedial video timestamp. This cannot be validated in model-mocked CI. No auto-execution of user code occurs.

## Remaining improvements

A future release should add free-text evaluation with human verification, configurable mastery rubrics, quiz editing/discarding, anti-repeat sampling, spaced review scheduling, and longitudinal mastery estimates. Do not interpret these short AI-generated question scores as employment readiness or certified expertise.
