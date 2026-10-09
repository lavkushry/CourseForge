# CourseForge Studio v3 — Adaptive learning UI

## Scope

This release redesigns the existing **single-user, local-first** FastAPI application without adding a frontend build chain. It integrates the real v2 APIs for playback, progress, indexed transcript segments, grounded tutoring, AI-generated study paths, flashcards, and three vetted Docker-graded labs.

## Views and navigation

| View | Available experience | Data source |
|---|---|---|
| Dashboard | Continue learning, indexed/completed counters, cards due, activity streak and self-rated recall | `/api/videos`, `/api/progress`, `/api/studio/insights` |
| Library | Course covers, categories, title search, progress filters, duration-based sorting | `/api/videos` and local browser filtering |
| Learning | Playback/resume, time-coded transcript, personal timestamped notes, AI summary, next lesson, syllabus entry point | `/api/videos/{id}`, `/api/videos/{id}/notes`, `/api/ask`, `/api/syllabus` |
| AI Tutor | Four modes, guided teaching prompt, concept-check prompt, session question history, confidence buttons, evidence links | `/api/ask`, local device confidence signals |
| Review | SM-2 cards, due queue, grade history, weak recall signals | `/api/reviews/*`, `/api/studio/insights` |
| Labs | Real curated lab catalog and Docker grading; five clearly labeled future lab categories | `/api/labs`, `/api/lab-sessions/*` |
| Settings | System/light/dark themes, indigo/teal/rose accent, daily target, local config status | localStorage and `/api/health` |

The **Study paths** view remains reachable through the Learning workspace; it is no longer a separate sidebar item. The primary navigation matches the seven product areas.

## Design system

CSS custom properties provide foundation tokens for backgrounds, semantic foreground text, borders, shadows, spacing, radii and transitions. The `data-theme` attribute preserves the chosen preference (`light`, `dark`, `system`); `data-resolved-theme` tracks the effective OS preference for `system`. The selected mode and accent are saved in `courseforge-theme-v3`. No CDN images, external font assets, tracking or remote analytics are required. Course covers are deterministic CSS gradients.

Keyboard/focus details: sidebar buttons are actual buttons; routes update `aria-current`; headings gain focus for explicit navigation; `/` focuses search, Escape closes popovers/drawer; theme controls expose `aria-pressed` and popovers `aria-expanded`; the responsive drawer has a backdrop. Reduced-motion preferences disable animations. The learning-room tabs declare tab roles and selected state.

## Real data versus planned functionality

- **Real:** imported videos, transcript chunks, playback positions, course progress, persistent notes, AI answers with source links, SM-2 card scheduling, grade history, and existing reviewed lab execution.
- **Real but approximate:** an inferred course category based on its filename; course-duration total based on available media metadata; mastery signal based strictly on the percentage of graded recalls marked Good/Easy; weak areas derived from cards marked Again.
- **Not available:** instructor details, user ratings, purchased-course synchronization, verified certificates, automatically graded free-form understanding, full time-on-task tracking, or arbitrary SQL/PySpark/Docker/Ansible/backend code execution. These UI surfaces either say “Not rated” or “Coming soon”; no fabricated values or runnable buttons are shown.
- **Storage:** progress, review history, notes and learning analytics are SQLite-backed. Theme, daily goal and tutor confidence self-report stay in browser localStorage (single-device); do not mistake them for server-synced metrics.

The typed `app/static/services.js` boundary has JSDoc DTO definitions and an explicit `unavailableCourseMetadata()` fallback. Its TODO identifies where validated user-supplied course manifests would eventually plug in.

## Data model changes

`video_notes` is an additive SQLite table; existing v2 data is preserved. `GET /api/videos/{video_id}/notes` lists notes. `POST /api/videos/{video_id}/notes` persists one note at a bounded timestamp. `DELETE /api/notes/{note_id}` deletes it. `GET /api/studio/insights` reads review attempts and completed-progress records; it never invents mastery from lecture completion. `/api/progress` now includes `updated_at`.

## Security and quality

All new backend writes use parameterized SQL and existing local-only origin/host restrictions. User-provided note text and tutor output are rendered using `textContent`, not `innerHTML`. Video files, .env and SQLite databases remain excluded by `.gitignore`. Lab execution keeps the existing hardened Docker grading path with no arbitrary AI command execution.

The browser UI is not authenticated and must stay bound to loopback. The app is not yet a hosted multi-user LMS.

## Validation

```bash
python -m pytest -q
python -m compileall -q app scripts
node --check app/static/app.js
node --check app/static/services.js
```

The Playwright/Chromium visual smoke exercise (optional developer setup) uses stubbed API data on desktop 1440px, tablet 820px and mobile 390px. It checks initial rendering, library filtering/sorting, theme/accents and mobile drawer interactions without relying on installed Ollama or Whisper models. It does not establish live AI model correctness.

### Local running

Follow the root README to install dependencies and models. Run `uvicorn app.main:app --host 127.0.0.1 --port 8000` and `python -m app.worker` in separate terminals, then open `http://127.0.0.1:8000`. After scanning, select a course, open a lesson, try its Notes and AI summary tabs, and review a generated card.

## Follow-up roadmap

- **P0:** Real-device end-to-end validation of media playback, the Whisper/Ollama/Qdrant ingestion pipeline, Docker/kind graders, and transcript provenance with one representative locally owned course.
- **P0:** Fix media container compatibility for browser playback (e.g. MKV remuxing/transcoding) with generated-file lifecycle and storage limits.
- **P1:** Source-backed course manifest metadata (instructor/tags/cover) and optional locally generated preview thumbnails.
- **P1:** Graded SQL, PySpark, Docker, Ansible and backend exercises in constrained dedicated environments; no arbitrary command execution.
- **P1:** Real session events for time-on-task, daily-goal completion, concept mastery by topic, adaptive quiz grading, prerequisite-aware study sequencing and spaced-repetition forecasts.
