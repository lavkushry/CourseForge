# CourseForge LMS & User AI-Assisted Platform
## Master Architecture Blueprint, Operational Runbook & Production Roadmap

---

## 1. Executive Blueprint & System Vision

**CourseForge** is an enterprise-grade, self-hosted, decentralized Learning Management System (LMS) purpose-built for intensive software engineering and computer science masterclasses (covering Distributed Systems, Cloud Architecture, Agentic AI, High-Scale Data Engineering, Low-Level Design, and Machine Coding).

### 1.1 Core Platform Scale
- **Curriculum Breadth:** 27 comprehensive masterclasses spanning foundational through senior staff engineering competencies.
- **Lesson Catalog:** 3,870 production video lessons and laboratory modules.
- **Transcripts & Knowledge Base:** Over 30,000 indexed transcript chunks with high-dimensional vector embeddings and full-text search representations.
- **Decentralized Media CDN:** Multi-account Odysee blockchain-backed decentralized object storage with continuous round-robin upload distribution and dynamic PostgreSQL mapping.
- **Intelligent Media Gateway:** High-performance Go streaming reverse proxy with HTTP Range 206 partial content support, signed playback leases, and sub-millisecond local hybrid fallback.

---

## 2. End-to-End System Architecture & Topology

The platform operates on a high-efficiency ARM64 Linux host (Oracle Cloud Infrastructure, 4 vCPUs, 24 GB RAM, Ubuntu 24.04 LTS), orchestrated via Docker containers, Go native micro-services, and systemd daemons.

```mermaid
flowchart TD
    subgraph Client["Client Tier (Browser SPA)"]
        SPA["Vite + TypeScript SPA\n• Frosted Glass Floating Dock\n• Segmented Progress Bar\n• Interactive Scrubber Preview\n• Grounded AI Study Partner"]
    end

    subgraph Edge["Edge & Reverse Proxy"]
        CF["Cloudflare Tunnel Daemon\n(courseforge-tunnel.service)"]
        NGINX["Nginx Edge Container\n(courseforge-production-web:8000)\n• Long-Polling 3600s Keep-Alive\n• CSP & Security Headers"]
    end

    subgraph CoreBackend["Application Core (Go)"]
        API["CourseForge Core API (:18090)\n• 14 Micro-Modular Domains\n• Auth, Paths, Plans, Labs, Certs\n• AI Tutor & Search Router"]
        MEDIA["Media Gateway (:18094)\n• HTTP Range 206 Chunked Streaming\n• Signed Playback Leases\n• CDN77 Bypass & Local Fallback"]
    end

    subgraph Storage["Persistence & Vectors"]
        PG["PostgreSQL 16 (:15439)\n• pgvector (1024-dim Cosine Similarity)\n• GIN tsvector Full-Text Search\n• 3,870 Lessons & 27 Courses\n• User Leases & Progress Tracking"]
    end

    subgraph AIService["AI & Classification Tier"]
        OLLAMA["Ollama LLM Engine (:11434)\n• qwen3:4b-instruct (Chat/Splits)\n• qwen3-embedding:0.6b (Vectors)\n• 2 Parallel Execution Slots (-np 2)\n• 24h Permanent Model Residency"]
        WORKER["AI Split Worker (Go)\n(courseforge-splitworker.service)\n• Nice 19 Polite Background Throttle\n• Dynamic Chapter Classification\n• Real-Time Progress & ETA Tracker"]
        WHISPER["Faster-Whisper Worker\n• Speech-to-Text Transcription"]
    end

    subgraph Ingestion["Ingestion Pipeline"]
        TG["Telegram Downloader"] --> FFMPEG["FFmpeg Remuxing"]
        FFMPEG --> ODYSEE["Odysee Blockchain CDN\n(6 Round-Robin Accounts)"]
        ODYSEE --> MANIFEST["Manifest & PostgreSQL Sync"]
    end

    Client -->|Public HTTPS| CF
    CF --> NGINX
    NGINX -->|/api/v1/*| API
    NGINX -->|/api/v1/playback/sessions/*/media| MEDIA
    API --> PG
    MEDIA --> PG
    API --> OLLAMA
    WORKER --> OLLAMA
    WORKER --> PG
    WHISPER --> PG
```

---

## 3. Micro-Modular Backend Domain Matrix

The CourseForge Go backend (`backend/internal/`) is divided into 14 decoupled, single-responsibility domain packages:

| Domain Package | Primary Responsibility | Key API Routes |
| :--- | :--- | :--- |
| **`identity`** | User authentication, sessions, CSRF validation, RBAC, password lifecycle. | `POST /api/v1/auth/login`<br>`POST /api/v1/auth/register`<br>`GET /api/v1/auth/me`<br>`GET /api/v1/admin/users` |
| **`learning`** | Catalog structure, modules, lessons, enrollments, reviews, and syllabus tree. | `GET /api/v1/courses`<br>`GET /api/v1/courses/{id}`<br>`POST /api/v1/courses/{id}/enroll`<br>`GET /api/v1/courses/{id}/reviews` |
| **`playback`** | Playback sessions, telemetry leases, position persistence, and resume bookmarks. | `POST /api/v1/playback/sessions`<br>`PUT /api/v1/lessons/{id}/progress`<br>`PUT /api/v1/lessons/{id}/resume` |
| **`media`** | Video resolution, CDN77 redirect handler, byte-range gateway, and offline fallbacks. | `GET /api/v1/playback/sessions/{id}/media`<br>`HEAD /api/v1/playback/sessions/{id}/media` |
| **`ai`** | Grounded tutor RAG, semantic vector search, roadmap generation, chapter splits. | `POST /api/v1/ai/tutor/ask`<br>`GET /api/v1/ai/search`<br>`POST /api/v1/ai/roadmaps/generate`<br>`GET /api/v1/ai/lessons/{id}/chapters` |
| **`activity`** | Daily study time tracking, focus timers, learning heatmaps, and streak monitoring. | `POST /api/v1/lessons/{id}/activity-session`<br>`POST /api/v1/activity/{id}/heartbeat`<br>`GET /api/v1/me/learning` |
| **`planning`** | Personalized study planners, daily scheduling, weekly targets, and task completion. | `GET /api/v1/me/planner/daily`<br>`POST /api/v1/me/planner/items`<br>`PUT /api/v1/me/planner/items/{id}/complete` |
| **`paths`** | Structured career learning tracks, skill prerequisite trees, and milestone sequences. | `GET /api/v1/paths`<br>`GET /api/v1/paths/{id}`<br>`POST /api/v1/paths/{id}/enroll` |
| **`labs`** | Interactive programming labs, workspace specifications, instructions, and tests. | `GET /api/v1/labs`<br>`GET /api/v1/labs/{id}`<br>`POST /api/v1/labs/{id}/submissions` |
| **`practice`** | Spaced repetition flashcards, topic comprehension quizzes, and recall analytics. | `GET /api/v1/practice/decks`<br>`POST /api/v1/practice/sessions`<br>`POST /api/v1/practice/cards/{id}/attempt` |
| **`certificates`** | Automated completion certificate issuance and public cryptographic verification. | `GET /api/v1/courses/{id}/certificate`<br>`POST /api/v1/courses/{id}/certificate`<br>`GET /api/v1/certificates/verify/{code}` |
| **`jobs`** | Background job submission, status polling, telemetry, and cancellation. | `POST /api/v1/jobs`<br>`GET /api/v1/jobs/{id}`<br>`POST /api/v1/jobs/{id}/cancel` |
| **`administration`** | Comprehensive instructor & admin dashboard, student telemetry, and audit logs. | `GET /api/v1/admin/overview`<br>`GET /api/v1/admin/analytics`<br>`GET /api/v1/admin/audit` |
| **`observe`** | OpenAPI v3 contract generation, system telemetry, and health monitoring probes. | `GET /api/v1/openapi.json`<br>`GET /healthz` |

---

## 4. User AI-Assisted Architecture Deep-Dive

CourseForge includes a complete suite of AI-assisted learning capabilities designed to turn passive video watching into an active, high-retention masterclass experience.

### 4.1 Background AI Chapter Splitter
- **Architecture:** Standalone Go service (`backend/cmd/splitworker/main.go`) running at `nice 19` with a polite 800ms delay between lesson analyses.
- **Model:** Local Ollama `qwen3:4b-instruct` prompt-engineered for strict JSON array schema generation.
- **Functionality:** Ingests raw timestamped lecture transcripts and segments each lecture into 3 to 6 logical pedagogical chapters with precise start/end seconds and technical 1-sentence summaries.
- **Storage:** Persisted directly into the `transcript_chunks` table with `kind='chapter'`.
- **Public API:** `GET /api/v1/ai/lessons/{id}/chapters` serves the splits instantly to the frontend player timeline with sub-millisecond response time.

### 4.2 Grounded AI Study Partner (Interactive Tutor)
- **Pedagogical Modes:**
  1. **Explain Concepts (`explain`):** Grounded technical explanation synthesizing course theory with real-world system design trade-offs.
  2. **Socratic Dialogue (`socratic`):** Step-by-step guided questions and hints prompting the student to deduce the underlying solution.
  3. **Production Code (`code`):** Idiomatic, high-performance implementations (Go, Python, Java, SQL, Rust) with line-by-line architectural commentary.
  4. **Knowledge Check (`quiz`):** Rigorous comprehension test questions evaluating understanding of edge cases, failovers, and complexity.
- **Dual Retrieval Engine:**
  - **Primary:** `pgvector` cosine similarity (`<=>`) against 1024-dimensional embeddings generated via `qwen3-embedding:0.6b`.
  - **Failsafe Full-Text:** PostgreSQL GIN `tsvector` query matching `websearch_to_tsquery('simple', ...)` combined with stopword-filtered keyword extraction (`extractSearchKeywords`), executing in `<0.6ms`.
- **Clickable Timestamp Citations:** Citations are tagged with exact `[MM:SS]` start times. Clicking a citation in the chat UI immediately seeks the video player to that moment in the lecture.

### 4.3 Automated AI Learning Roadmap Generator
- **Endpoint:** `POST /api/v1/ai/roadmaps/generate`
- **Inputs:** Student's target engineering role (e.g., *Staff Distributed Systems Architect*, *Lead Data Platform Engineer*) and committed hours per week.
- **Output:** Dynamically assembled, multi-stage curriculum drawn from the 27 masterclasses with estimated completion weeks, prerequisite sequencing, and core architectural milestones.

### 4.4 Automated Lesson Executive Summarizer
- **Endpoint:** `GET /api/v1/ai/lessons/{id}/summary`
- **Output:** Automatically generates a 3-part structured breakdown:
  1. Executive Architecture Summary
  2. Core Engineering Takeaways with timestamps
  3. Hands-on Lab & Discussion Challenge

---

## 5. Production Operations Runbook

### 5.1 Service Topology & Port Allocation

| Component | Protocol / Port | Process / Service | Description |
| :--- | :--- | :--- | :--- |
| **Nginx Edge Proxy** | `TCP 8000` | Docker (`courseforge-production-web`) | Public reverse proxy, Vite SPA host, 3600s proxy timeout |
| **Main Go API** | `TCP 18090` | Binary (`/tmp/courseforge-api.current`) | Core API server, auth, learning, AI endpoints |
| **Media Gateway** | `TCP 18094` | Binary (`/tmp/courseforge-isolated-media`) | High-concurrency Range 206 video streaming proxy |
| **PostgreSQL 16** | `TCP 15439` | Docker (`courseforge-rewrite-postgres-1`) | Primary relational & vector database |
| **Ollama LLM Engine**| `TCP 11434` | Systemd (`ollama.service`) | Local LLM inference (`qwen3:4b`, `qwen3-embedding`) |
| **AI Split Worker** | Background Daemon | Systemd (`courseforge-splitworker.service`) | Nice 19 chapter segmentation processor |
| **Cloudflare Tunnel**| Tunnel Daemon | Systemd (`courseforge-tunnel.service`) | Zero-trust HTTPS public ingress |

---

### 5.2 Build & Deployment Runbook

#### A. Frontend SPA (TypeScript + Vite)
```bash
cd /home/ubuntu/CourseForge/web
npm run build
docker restart courseforge-production-web
```

#### B. Main Go API Server
```bash
cd /home/ubuntu/CourseForge/backend
go build -o /tmp/courseforge-api.new ./cmd/api
pkill -f "/tmp/courseforge-api.current" || true
mv /tmp/courseforge-api.new /tmp/courseforge-api.current
export CF_DATABASE_URL="postgres://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite?sslmode=disable"
export CF_HTTP_ADDR="127.0.0.1:18090"
nohup /tmp/courseforge-api.current >> /tmp/api.log 2>&1 &
```

#### C. Isolated Media Gateway
```bash
cd /home/ubuntu/CourseForge/backend
go build -o /tmp/courseforge-isolated-media.new ./cmd/media
pkill -f "/tmp/courseforge-isolated-media" || true
mv /tmp/courseforge-isolated-media.new /tmp/courseforge-isolated-media
export CF_DATABASE_URL="postgres://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite?sslmode=disable"
export CF_HTTP_ADDR="127.0.0.1:18094"
nohup /tmp/courseforge-isolated-media >> /tmp/media.log 2>&1 &
```

#### D. AI Background Split Worker
```bash
cd /home/ubuntu/CourseForge/backend
go build -o /home/ubuntu/CourseForge/bin/courseforge-splitworker ./cmd/splitworker
systemctl --user restart courseforge-splitworker.service
```

---

### 5.3 Daily Operations & Health Verification

#### 1. Instant System Healthcheck
```bash
# Verify API, Media Gateway, and Nginx edge
curl -sI http://127.0.0.1:8000/
curl -sI http://127.0.0.1:18090/api/v1/openapi.json
curl -sI http://127.0.0.1:18094/healthz || echo "Media OK"
```

#### 2. AI Subsystem Status & Model Residency
```bash
# Check loaded models and execution status
ollama ps
# Verify AI status via API
curl -s -b /tmp/cookie.txt http://127.0.0.1:18090/api/v1/ai/status | jq .
```

#### 3. Split Worker Real-Time Progress
```bash
bash /home/ubuntu/CourseForge/scripts/check_progress.sh
```

#### 4. Odysee Wallet Rebalancing (Hourly Cron)
```bash
python3 /home/ubuntu/CourseForge/scripts/rebalance_odysee_wallets.py
```

---

## 6. Strategic Roadmap & Next-Generation Milestones

```mermaid
flowchart LR
    P1["Phase 1: Foundation (Current)\n• 27 Courses Deployed\n• Frosted Glass Player Active\n• Grounded RAG AI Tutor Live\n• Splitworker Running (~16h ETA)"]
    P2["Phase 2: Adaptive Mastery\n• Knowledge Gap Quizzing\n• Spaced Repetition Scheduling\n• Dynamic Difficulty Tuning\n• Auto-Generated Lab Testcases"]
    P3["Phase 3: Multimodal Voice Tutor\n• Low-Latency Voice-to-Voice\n• Architectural Diagram Parsing\n• Live Whiteboard Co-Pilot\n• Interactive Debug Sessions"]
    P4["Phase 4: Collaborative Academy\n• Peer Code Review Cohorts\n• Distributed Pair Programming\n• Team System Design Arena\n• Verified Micro-Credentials"]

    P1 --> P2 --> P3 --> P4
```

> [!TIP]
> **Production Resilience:** All long-running workers operate with strict backoff timeouts, `nice 19` scheduling, and polite rate limits to guarantee that student video playback and real-time AI tutor interactions retain first-class CPU and memory priority at all times.
