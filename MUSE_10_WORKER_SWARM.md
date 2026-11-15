> **DEPRECATED ENTRY POINT.** Do not run this as one Muse prompt. Use one file under [`docs/muse/workers/`](docs/muse/workers/) at a time per [`docs/muse/HOW_TO_RUN.md`](docs/muse/HOW_TO_RUN.md). Worker 10 is Cursor-only (`scripts/muse_verify.sh`).

# Muse 10-Worker Execution Matrix: CourseForge & ForgeCareer ($1T Startup Quality)

You are the Executive Swarm Orchestrator operating inside `/home/ubuntu/CourseForge`.
Divide your execution into **10 Specialized Autonomous Workers** working at full potential.

---

## Worker Assignments & Scopes

### 🎨 Frontend Guild (Workers 1–4)
- **Worker 1: UI Design System & Tokens (`UI-Design-System`)**
  - **Scope**: `web/src/career/style.css`, static CSS tokens, theme variables.
  - **Directives**: Deliver Linear/Stripe/Raycast grade minimal realism. Crisp 1px hairline borders (`rgba(255, 255, 255, 0.08)`), dark slate matte surfaces (`#0b1120`, `#111827`, `#131b2e`), zero neon clutter, micro-interactions, responsive grid layout.

- **Worker 2: Autonomous Engine Tabs (`UI-Engine-Worker`)**
  - **Scope**: `web/src/career/view.ts` (Engine views).
  - **Directives**: Perfect the 4 Autonomous Engine Views:
    1. `Goal & CRM`: 5-calls/day pacing gauge, 6-stage bottleneck diagnostic banners, recruiter CRM pipeline.
    2. `Daily Plan`: 3 daily blocks (Morning Apply, Afternoon Outbound, Evening Sweep & Follow-up).
    3. `Profile SEO (Boost)`: Resdex bump, LinUCB bandit scores, dynamic keyword utility matrix, 4-stage mutation audit trail.
    4. `App Ledger`: Live application ledger with filters, status pills, and streaming CSV export.

- **Worker 3: Studio & Story Panels (`UI-Studio-Worker`)**
  - **Scope**: `web/src/career/view.ts` (Studio panels).
  - **Directives**: Perfect the 9 Studio Panels:
    1. `My Story & Facts`: Candidate story banner, resume auto-extractor, confirmed facts catalog.
    2. `Resume & PDF`: Versions, LaTeX compilation, PDF download, ATS skim-audit breakdown.
    3. `JD Match`: Keyword scoring and gap analysis.
    4. `Companies`: Target company profiles and parsed JDs.
    5. `Role Tracks`: Engineering track classifiers.
    6. `Outcome Tracker`: Funnel progression pipeline.
    7. `Referrals`: Contact outreach directory and pitch drafting.
    8. `Analytics (CI)`: Wilson confidence intervals and interview rate statistics.
    9. `Job Alerts`: Alert rules and notification center.
    10. `All Options`: Comprehensive panoramic workspace.

- **Worker 4: Client-Side User Isolation (`UI-Isolation-Worker`)**
  - **Scope**: `web/src/settings/view.ts`, `web/src/tutor/view.ts`, `web/src/career/view.ts`.
  - **Directives**: Ensure 100% per-user isolation for local client state. All localStorage keys MUST be prefixed by `${account.id}` (tutor history, daily study goals, task checklists). Zero state leaks between users.

---

### ⚙️ Go Backend Guild (Workers 5–7)
- **Worker 5: Career Domain & REST API (`Go-API-Worker`)**
  - **Scope**: `backend/internal/career/service.go`, `handlers.go`, `domain.go`.
  - **Directives**: SOLID Hexagonal architecture, clean error handling via `httpx.Error`, atomic transaction wrappers, zero allocation hot paths.

- **Worker 6: Multi-Profile Onboarding & Auth Vault (`Go-Vault-Worker`)**
  - **Scope**: `backend/internal/career/profile_onboarding.go`, `auth_vault.go`, `engine_control.go`.
  - **Directives**: PDF/text resume parser with 8-track classification, dynamic whitelist tokens, AES-256-GCM vault encryption/decryption, pre-flight readiness gate (`ProfileReady`, `WhitelistReady`, `AuthReady`).

- **Worker 7: PostgreSQL Isolation & Data Integrity (`Go-DB-Worker`)**
  - **Scope**: PostgreSQL connection pool and migrations (`015_career_studio.sql`, `035_universal_career_profiles.sql`).
  - **Directives**: Enforce strict `WHERE user_id = $1` on every query. Composite primary keys `(user_id, token)`, isolated pacing dates, per-user mutations with SHA-256 provenance.

---

### 🐍 Python Worker Guild (Workers 8–9)
- **Worker 8: Stealth Playwright Adapters (`Python-Playwright-Worker`)**
  - **Scope**: `services/career_worker/adapters/` (`naukri_adapter.py`, `linkedin_adapter.py`, `simulation_adapter.py`).
  - **Directives**: Multi-tenant session isolation (`cookies/<user_id>/<platform>_cookies.json`), Playwright stealth DOM interactions, resilient fallback to SimulationAdapter.

- **Worker 9: LinUCB Bandit & Recruiter CRM Engine (`Python-Bandit-Worker`)**
  - **Scope**: `services/career_worker/modules/` (`policy.py`, `mutator.py`, `keyword_miner.py`, `pacing.py`, `crm.py`).
  - **Directives**: LinUCB contextual bandit ($d=7$), exploration parameter $\alpha=0.25$, mutation whitelist/blacklist guards, 300-char connection notes, 48h/7d follow-up cadence.

---

### 🛡️ QA, Verification & Deployment (Worker 10)
- **Worker 10: E2E Verification & Deployment Orchestrator (`QA-Deploy-Worker`)**
  - **Scope**: `tests/career_e2e/runner.py`, Go test suite, Web build, systemd services.
  - **Verification Pipeline**:
    1. `go test -v ./internal/career/... ./internal/store/migrations/... ./cmd/api/...`
    2. `npm run build` in `web/`
    3. `pytest -v services/career_worker/tests/`
    4. `python3 tests/career_e2e/runner.py` (Must pass all 382/382 tests)
    5. Service restart: `courseforge-api@18090`, `courseforge-api@18091`, `courseforge-career-worker`
    6. Edge reload: `docker exec courseforge-production-web nginx -s reload`
    7. Health check: `curl -s http://localhost:18095/health`, `curl -k -s https://127.0.0.1:8000/api/health`

---

## Execution Protocol

Run all 10 worker scopes concurrently or sequentially in prioritized batches. Every worker must report verification status and preserve all 382 E2E test invariants.
