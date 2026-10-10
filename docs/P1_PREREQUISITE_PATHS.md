# P1 — Cross-course prerequisite-aware learning paths

## How to use
1. Import your video courses and let the processing worker index the lessons.
2. Open Learning → Study paths and build a source-grounded syllabus for each course you want to combine.
3. Select up to eight indexed courses in Build one adaptive roadmap.
4. Enter your goal, such as "Become a data engineer using SQL, Python, Spark and Databricks".
5. Build the path, follow suggested prerequisites, and jump to original lecture timestamps.
6. Mark topics complete yourself. Watched videos do not automatically prove mastery.

## Storage and trust boundaries
- Existing per-course syllabus snapshots provide topics and video source references.
- New SQLite tables are learning_paths (goal, course IDs, fingerprint, snapshot) and learning_path_completions (learner-checked topic IDs).
- Only topics backed by actual indexed video IDs matching the owning course are allowed.
- Duplicate topics collapse lexically across courses while preserving supporting courses, video IDs and timestamps.
- Local Ollama can suggest prerequisite edges and goal-relevant topics. Suggested IDs must exist in selected sources. Cycles, self-references, and duplicate edges are rejected.
- When Ollama fails or AI is disabled, clearly labeled conservative local prerequisite rules replace model planning.
- Topological sorting respects accepted dependencies. A prerequisite must be marked complete before its dependents.
- A stable path identifier preserves matching topic completions when the same goal and courses are regenerated.
- When a foundational topic is marked incomplete, its completed dependents are also reset.
- Changes to source syllabi mark a saved path as outdated. Rebuild the course syllabi before refreshing the path.
- All processing and state remain local by default. Do not expose unauthenticated FastAPI endpoints publicly.

## API
| Endpoint | Purpose |
|---|---|
| GET /api/learning-paths | Saved path summaries |
| POST /api/learning-paths | Create or refresh a goal-based plan with courses, goal and use_ai |
| GET /api/learning-paths/{path_id} | Roadmap, dependencies, completion, evidence, next available step |
| PUT /api/learning-paths/{path_id}/steps/{step_id} | Mark complete or incomplete |

Example POST JSON: {"courses":["SQL","Python"],"goal":"Learn data engineering","use_ai":true}

Example PUT JSON: {"completed":true}

## Verification
Commands:

    python -m pytest -q
    python -m compileall -q app scripts
    node --check app/static/app.js
    node --check app/static/services.js
    node --check app/static/learning-paths.js

The suite tests deduplication, timestamp links, invalid and cyclic edges, prerequisite gating, completion persistence, API contracts, and offline fallback. Browser smoke checks use simulated lecture data. Real prerequisite quality from Ollama and playback on your actual Mac videos remain to be validated.

## Limits
- At most eight selected courses and 100 unique topics per path.
- A model-generated prerequisite edge is an educational suggestion, not independently validated knowledge.
- Goal prioritization is based on syllabus topics and optional AI focus IDs, not formal competency assessment.
- No external Coursera/Udemy account data is accessed.
