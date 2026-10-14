# CourseForge Career / Resume module

In-app career studio for role-track fit, company hiring profiles, ATS-safe resumes,
application analytics, referral drafts, apply-early board alerts, and skill-gap
links into the CourseForge catalog.

## Principles

- **Never fabricate facts.** Bullet suggestions reuse only user-confirmed facts.
  Missing metrics become `[METRIC]` placeholders the learner fills in.
- **Never send emails or messages.** Referral drafts and opening alerts stay in-app
  (clipboard / notifications only).
- **AI optional.** JD signal extraction uses `internal/ai` when available and falls
  back to deterministic keyword matching otherwise.
- **Additive schema.** Migrations `016_career.sql` … `019_career_alerts.sql`.

## Role tracks & hiring fit

Seeded tracks (`devops`, `backend`, `frontend`, `fullstack`, `data`, `ml`, `sre`,
`mobile`) each have section order and weighted keyword sets.

Learners add companies, paste multiple JDs, and build a hiring profile from
repeated skills / tools / seniority signals. Match scoring returns matched and
missing keywords, a weighted score, grounded bullet rewrites, and skill-gap
bridges (below).

## LaTeX resumes

Two ATS-safe single-column templates render structured resume data with proper
escaping. Export workers compile via `tectonic` or `latexmk`, verify an extractable
PDF text layer, and score recruiter skim quality on the top third of the page.
Versions are immutable snapshots per application.

## Tracker & analytics

Applications track status (`applied` → `callback` → `interview` → `offer` /
`rejected`), resume version type (`original` | `tailored`), rejection reason, and
applied-days-after-posting. CSV import supports dry-run validation.

Analytics report callback and interview rates with 95% Wilson intervals and an
explicit **n&lt;100 unreliable** warning. Matched-pair views contrast original vs
tailored outcomes for the same company + track.

## Referrals

Contacts (alumni / cohort / colleague) can be entered or CSV-imported. Matching is
by company name. Draft messages are copy-to-clipboard only.

## Apply-early alerts

Learners register careers board sources:

| Provider    | Board API |
| ----------- | --------- |
| Greenhouse  | `boards-api.greenhouse.io/v1/boards/{token}/jobs` |
| Lever       | `api.lever.co/v0/postings/{company}?mode=json` |
| Ashby       | `api.ashbyhq.com/posting-api/job-board/{name}` |

The **export** job worker runs `RunAlertPollLoop`:

- Claims due sources with `FOR UPDATE SKIP LOCKED`
- Polite inter-request spacing and per-source poll intervals (default 15 minutes)
- `If-None-Match` / `If-Modified-Since` (ETag / Last-Modified)
- Exponential backoff on failures (capped at 1 hour)
- Opening dedupe on `(source_id, external_id)`
- Keyword / role-track matching creates **in-app** `career_notifications` only

Tests drive boards through `httptest` fixtures — no live network.

API:

- `GET/POST /api/v1/career/alert-sources`
- `DELETE /api/v1/career/alert-sources/{id}`
- `GET /api/v1/career/notifications`
- `POST /api/v1/career/notifications/{id}/read`
- `POST /api/v1/career/notifications/read-all`

## Skill-gap bridge

On `POST /api/v1/career/match`, missing keywords are mapped to published courses
(by tags, title, category, description) and lessons (by title). The match panel
shows course and `#learning/{lesson_id}` links. No content is invented outside the
catalog.

## UI

Career Studio nav entry (`#nav-career`) under the existing dark LMS theme
(accent `#E54503`, canvas / panel / muted tokens, Inter). Light theme and
`data-accent` teal|rose switching continue to use shared design tokens.

## Layout (backend)

| Area | Package / files |
| ---- | --------------- |
| HTTP API | `backend/internal/career/service.go` (+ handlers) |
| Extraction / match | `extract.go`, `match.go`, `skillgap.go` |
| Resumes | `latex.go`, `compile.go`, `worker.go`, `skim.go` |
| Tracker | `tracker.go`, `analytics.go`, `import.go`, `referrals.go` |
| Alerts | `alerts.go`, `boards.go`, `poll.go` |
| Migrations | `backend/internal/store/migrations/016–019_career*.sql` |
| Worker | `backend/cmd/worker` export resource |
