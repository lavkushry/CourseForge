> **DEPRECATED ENTRY POINT.** Do not paste this whole file into Muse — it wastes credits on whole-system audits. Use surgical workers instead: [`docs/muse/HOW_TO_RUN.md`](docs/muse/HOW_TO_RUN.md). Cursor owns verification via `scripts/muse_verify.sh`.

# Master Directive: CourseForge ($1T Startup Quality Architecture & UI Refactor)

You are the Lead Principal Software Architect and Design Technologist operating inside `/home/ubuntu/CourseForge`.

Your objective is to refactor, harden, and elevate the entire **CourseForge** platform — uniting adaptive learning (`CourseForge`) with the autonomous career engine (`ForgeCareer`) — to the highest standard of technical perfection, reliability, and minimal design seen in trillion-dollar startups (e.g. Stripe, Linear, Vercel, Raycast).

---

## 1. System Invariants & Live Environment

1. **Repository Root**: `/home/ubuntu/CourseForge`
2. **Branch & Parity**: `main` (tracked against `https://github.com/lavkushry/CourseForge.git`).
3. **PostgreSQL Database**:
   - Host/Port: `127.0.0.1:15439` (Docker container: `courseforge-rewrite-postgres-1`).
   - Database: `courseforge_rewrite`, User: `courseforge`.
   - Migrations: `backend/internal/store/migrations/` (001–035, notably `015_career_studio.sql` and `035_universal_career_profiles.sql`).
4. **Active Systemd User Services**:
   - `courseforge-api@18090.service` & `courseforge-api@18091.service` (Go API Cluster)
   - `courseforge-career-worker.service` (Python FastAPI Daemon on `127.0.0.1:18095`)
   - `courseforge-production-web` (nginx container serving `/usr/share/nginx/html` mounted from `/home/ubuntu/releases/20261026-f1eb844/web/dist`)
   - `courseforge-tunnel.service` (Cloudflare Tunnel routing to `https://127.0.0.1:8000`)
5. **E2E Test Suite**:
   - Python environment: `/home/ubuntu/Resume/.venv/bin/python3`
   - Runner: `/home/ubuntu/Resume/.venv/bin/python3 tests/career_e2e/runner.py`
   - **Baseline: 382/382 passing tests across Tiers 1–4.** Any refactor MUST maintain 100% test pass rate.

---

## 2. Refactoring Blueprint

### A. Frontend Perfection (`web/src/career`, `web/src/app`)
- **Aesthetic**: Linear / Stripe / Raycast grade minimal realism. Crisp 1px hairline borders (`rgba(255, 255, 255, 0.08)`), matte slate surfaces (`#0b1120`, `#111827`, `#131b2e`), zero neon/glitz clutter.
- **Tabular Precision**: `font-variant-numeric: tabular-nums` across all counters, telemetry, Wilson confidence scores, and pacing ratios.
- **Unified Navigation**: Seamlessly toggle between:
  - **4 Autonomous Engine Views**: `Goal & CRM`, `Daily Plan`, `Profile SEO (Boost)`, `App Ledger`.
  - **9 Studio & Story Views**: `My Story & Facts`, `Resume & PDF`, `JD Match`, `Companies`, `Role Tracks`, `Outcome Tracker`, `Referrals`, `Analytics (CI)`, `Job Alerts`, plus `All Options` panoramic view.
- **Per-User Isolation**: All client-side storage (tutor history, daily study goals, task checklists) MUST strictly prefix storage keys by user ID (`${account.id}`).

### B. Go Backend Perfection (`backend/internal/career`, `backend/cmd/api`)
- **SOLID & Hexagonal Domain Design**:
  - Keep domain services decoupled from transport layers.
  - Strict SQL query scoping: every single career query MUST enforce `WHERE user_id = $1`.
  - Authenticated AES-256-GCM vault: decrypt credentials and cookies on-demand in-memory only; never log secrets.
  - Zero allocation hot-path parsing for PDF and text resumes.
  - Clean error codes using `httpx.Error(w, status, code, message)`.

### C. Python Worker Sidecar (`services/career_worker`)
- **FastAPI Daemon**: Runs on `127.0.0.1:18095` with graceful locking (`acquire_worker_lock`), process concurrency guards, and health checks.
- **Session Vault**: Multi-tenant session files located at `cookies/<user_id>/<platform>_cookies.json`.
- **Stealth Playwright Automation**: Headless adapters for Naukri and LinkedIn with deterministic SimulationAdapter fallbacks.
- **LinUCB Contextual Bandit**: Dimension `d=7`, alpha exploration tuning, update matrices $A \leftarrow A + x x^T$ and $b \leftarrow b + r x$.

---

## 3. Standard Verification & Deployment Commands

```bash
# 1. Build & Test Go Backend
export PATH=$PATH:/usr/local/go/bin:/snap/bin:$HOME/go/bin
export GOCACHE=/tmp/go-build-cache
cd /home/ubuntu/CourseForge/backend
go build -o /home/ubuntu/CourseForge/bin/courseforge-api ./cmd/api
go test -v ./internal/career/... ./internal/store/migrations/... ./cmd/api/...
rm -rf /tmp/go-build-cache

# 2. Build Web Frontend & Deploy to Web Root
cd /home/ubuntu/CourseForge/web
npm run build
cp -r dist/* /home/ubuntu/releases/20261026-f1eb844/web/dist/
docker exec courseforge-production-web nginx -s reload

# 3. Test Python Worker & 4-Tier E2E Suite
cd /home/ubuntu/CourseForge
/home/ubuntu/Resume/.venv/bin/pytest -v services/career_worker/tests/
/home/ubuntu/Resume/.venv/bin/python3 tests/career_e2e/runner.py

# 4. Restart Services & Verify Live Health
systemctl --user restart courseforge-api@18090.service courseforge-api@18091.service courseforge-career-worker.service
curl -s http://localhost:18095/health
curl -k -s https://127.0.0.1:8000/api/health
```

---

Execute with maximum care, precision, and adherence to clean architecture principles.
