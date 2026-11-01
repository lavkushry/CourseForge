# CourseForge & Career Studio Engineering Invariants

## 1. Remote Server & Deployment Topology
- **Production Host**: Always target `ubuntu@130.210.19.226` for production deployments. Never use the obsolete test host `141.148.195.233`.
- **Systemd User Units**: Career automation is scheduled via systemd user timers:
  - `courseforge-career-worker.service` (Permanent FastAPI sidecar on `:18095`)
  - `courseforge-career-agy.timer` (3x daily: 09:15, 14:30, 18:00 IST)
  - `courseforge-career-label.timer` (Daily 21:00 IST)
  - `courseforge-career-mutate.timer` (Tue/Thu 09:30 IST)
  - `courseforge-career-digest.timer` (Mon 03:00 IST)

## 2. Process & Worker Isolation Pattern
- **Browser Automation Decoupling**: All Playwright, scraping, and browser automation tasks must run within `services/career_worker` (FastAPI HTTP sidecar on `127.0.0.1:18095`).
- Never spawn ad-hoc browser processes directly from Go API request handlers.
- Always guard automation scripts with `/tmp/courseforge_career.lock` to prevent concurrency conflicts between manual CLI runs and background timers.

## 3. Database & Planning Integrity
- **Unified Planner Tasks**: When scheduling career tasks into CourseForge, use `daily_plan_items` with kinds `career_boost`, `career_apply`, `career_outreach`, or `career_followup`.
- **Data Ingestion**: Always map historical platform names (`naukri`, `linkedin`, `career_portal`, `career_portal_confirmed`) into `career_applied_jobs`.

## 4. Candidate Ground-Truth Protection
- The candidate's core profile facts are immutable:
  - Name: Lavkush Kumar
  - Experience: 2.5 YOE (Azure Data Engineer / Lakehouse)
  - Notice Period: <= 15 Days (Immediate Joiner)
  - Current CTC: ₹12 LPA | Expected CTC: ₹20–25 LPA
  - Employers: CGI, HFCL
- Automated profile mutators are restricted to token headline rotation (Naukri <= 250 chars, LinkedIn <= 220 chars) and skill reordering. Never modify factual employment, CTC, or notice period values.
