# Changelog

All notable changes to CourseForge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-11-01

First public release of CourseForge: a self-hosted learning studio that turns
course videos you already own into searchable knowledge, with local AI.

### Added

- **Academy** — authenticated accounts, invitations, free enrollment for
  published courses, admin reports, account suspension, course publishing,
  player session filters, CSV export and an audit log.
- **Learning Studio (v3)** — overview, searchable library, focused learning
  room, AI tutor, study paths, flashcards and practice labs, with
  light/dark/system themes.
- **Local AI pipeline** — Faster-Whisper transcription with timestamps,
  frame sampling with OCR/vision captions, Qdrant semantic search and an
  Ollama-powered tutor that cites source timestamps. No cloud calls.
- **Career Studio (ForgeCareer)** — resume tailoring and PDF export,
  job-description matching, company and role tracks, outcome tracking,
  referrals and job alerts, with strict per-user story/data isolation,
  multi-profile resume onboarding and an AES-256-GCM credential vault.
- **Habit loop** — daily streaks and goals, focus (Pomodoro) timer with
  analytics, autoplay-next, course completion certificates and weekly recaps.
- **Graded labs** — pre-reviewed Python, SQL, shell, PySpark, Docker and
  Ansible exercises graded in restricted Docker containers; adaptive practice
  recommends labs for topics where concept checks show a gap.
- **Mobile-first player** — responsive layouts audited at 320/390/768 px,
  thumb-zone navigation, ≥44 px touch targets, keyboard shortcuts and a
  developer `forge` CLI.
- **Go + TypeScript rewrite track** — Go API/media gateway and Vite player
  under `backend/` and `web/`, covered by CI alongside the Python suite.

### Notes

- The detailed phase-by-phase history that previously lived in the README
  (Phases 1–3, P0/P1 steps) remains documented under `docs/`.
