# CourseForge Local v2

**Turn downloaded video courses into a private AI tutor, a de-duplicated study plan, scheduled recall cards, and verifiable hands-on labs.** All video content stays on your computer when you keep the supplied loopback-only configuration. No account or cloud API is needed. Internet access is necessary for initial dependency/model downloads.

This is an **advanced single-user local prototype**. Unit and media-extraction integration tests are included. Full real-model and Docker/kind checks require running the supplied smoke test on your own machine; they are not guaranteed to pass without installing the stated prerequisites.

## Step 10 — Real-device acceptance gate

To validate a real local lecture, source timestamps, note cleanup, focus timer lifecycle, and opt-in live Chromium / Whisper–Ollama–Qdrant / Docker grading, run `python scripts/acceptance_live.py --video-id YOUR_VIDEO_ID --focus --docker-lab --real-ai --browser`. The full gate **must run on your own machine**; CI cannot see your downloaded courses or local services. See [the real-device acceptance runbook](docs/P0_REAL_DEVICE_ACCEPTANCE.md).

## Step 9 — Focus Timer and Analytics

The **Today’s plan** screen includes a Pomodoro-style focus/break timer (1–120 minutes), pause/resume/finish/discard, persistent interval history, daily task/lesson/lab linking, and a weekly planned vs manually reported vs server-measured time chart. The three metrics remain separate and do not imply mastery. The timer attempts to pause when the browser tab becomes hidden, and server-side sessions never exceed their configured duration. See [`docs/P1_FOCUS_TIMER.md`](docs/P1_FOCUS_TIMER.md).

## What is working

| Feature | Behavior |
|---|---|
| Folder library | Discover `.mp4`, `.mkv`, `.mov`, `.avi`, `.webm`, `.m4v`; group by course folder; durable SQLite queue |
| Transcript | Faster-Whisper speech recognition with timestamps and cached segments |
| On-screen visual interpretation | FFmpeg changed-frame samples, Tesseract OCR, optional Gemma 3 local vision captions |
| RAG tutor | Ollama embeddings, Qdrant semantic search, SQLite FTS fallback; lecture citations + timestamp links |
| De-duplicated syllabus | Local model extracts topics from sampled lecture excerpts; merges lexical and embedding-similar topics; preserves sources |
| Watch history | Saves current playback position, percentage and completion locally in SQLite |
| Spaced repetition | Source-linked flashcards, answer reveal and learner quality 0–5; SM-2 interval scheduling |
| Verifiable practice | Eight **curated** labs: Python, shell, Kubernetes, SQL, PySpark, Docker, Ansible and backend API; submit code for automatic tests in a locked-down Docker runner |
| Optional kind check | Kubernetes server-side dry-run in dedicated project-created `courseforge-lab` cluster only; never uses normal kubeconfig |
| Verification | `pytest`, FFmpeg integration, API tests, grader checks, and an optional real-model E2E CLI |

**Deliberate safety limit:** AI can propose other practice exercises in the tutor, but it cannot run arbitrary generated commands. Only pre-reviewed lab templates have executable graders. The Kubernetes lab performs static checks by default; cluster API dry-run is opt-in and does not deploy actual workloads.


## P1.7: Personalized daily learning planner

Open **Today's plan** from the sidebar or dashboard. Select a realistic daily time budget (15–180 minutes) and optionally a cross-course learning roadmap. Click **Build / refresh plan** to combine due flashcards, source-linked lessons, unlocked topics, assessments and curated labs into one prioritized schedule. Source lecture actions seek to the original timestamp; lab actions open only reviewed lab templates. Plans and your own checklist statuses persist in SQLite. You can select another calendar date; the browser passes its local timezone offset to avoid UTC day-boundary surprises.

**Checklist ≠ mastery.** Checking off an action never awards quiz points, never grades reviews or labs, and never claims video progress. Scheduled durations are planning estimates, not watched-time measurements. A 15-minute day stays within the 15-minute budget. See [`docs/P1_DAILY_PLANNER.md`](docs/P1_DAILY_PLANNER.md) for endpoints, data rules, and caveats.

## P1: Cross-course, prerequisite-aware learning roadmaps

CourseForge can combine existing source-linked course syllabi into a single goal-oriented path, merge repeated topics across different courses, and suggest prerequisites without fabricating lectures. From **Learning → Study paths**, build each course syllabus first; then select up to eight courses, enter a concrete goal, and build a combined roadmap.

Saved roadmaps preserve exact lecture timestamps and your explicit step completions. Inferred prerequisite edges are validated against known topic IDs and cycles are rejected. Watching a source video does **not** automatically claim you mastered its concept. The planner defaults to local Ollama suggestions and labels conservative local-rule fallback when Ollama is unavailable.

Read [`docs/P1_PREREQUISITE_PATHS.md`](docs/P1_PREREQUISITE_PATHS.md) for API details, source-fidelity constraints, testing and limitations.

## Requirements

- Mac or Linux computer, ideally 16 GB+ RAM for multiple AI models. A faster CPU/GPU helps significantly.
- Python 3.12 recommended, FFmpeg/FFprobe, Tesseract OCR, Docker Desktop/Engine, Ollama.
- `kind` and `kubectl` **only** if you want the optional dedicated Kubernetes lab cluster.

On macOS with Homebrew, first install Docker Desktop separately, then:

```bash
brew install python@3.12 ffmpeg tesseract ollama
```

## Install — first run

From the extracted `courseforge-local` directory:

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` to point at your existing course folder. Use an absolute path, with quotes if it contains spaces:

```ini
COURSES_DIR="/Users/you/Downloads/Video Courses"
DATA_DIR="/Users/you/CourseForgeData"
ENABLE_VISION=1
MAX_VISION_FRAMES_PER_VIDEO=12
```

Your course library can look like:

```text
Video Courses/
  Data Engineering/
    01-sql.mp4
    02-spark.mkv
  Kubernetes/
    01-pods.mp4
    02-services.mp4
  Ansible/
    01-inventory.mp4
```

Start Docker Desktop and Ollama (the Ollama app or `ollama serve` in a different terminal). Then download verified public Ollama model tags:

```bash
ollama pull qwen3:4b-instruct
ollama pull qwen3-embedding:0.6b
ollama pull gemma3:4b
```

Start Qdrant and **build the dedicated lab grader image**:

```bash
docker compose up -d
docker build -f docker/lab.Dockerfile -t courseforge-lab:local .
# Required only when running the PySpark exercise (larger download):
docker build -f docker/lab-spark.Dockerfile -t courseforge-lab-spark:local .
python scripts/doctor.py
```

Start API/UI in terminal 1:

```bash
source .venv/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Start the worker in terminal 2:

```bash
source .venv/bin/activate
python -m app.worker
```

Open **http://127.0.0.1:8000**. Click **Scan Library**. The worker processes lectures one at a time; the UI shows queued, processing and failed jobs. Use the 4 tutor modes for questions, notes, quizzes or explanations; source citations jump to original video positions.

## Workflows

### 1. Turn videos into searchable knowledge

1. Choose a representative short course with 3–5 lectures first.
2. Scan Library and wait for each lecture status to read `done`.
3. Search or ask a course-specific question; check the linked screenshots and video timestamps against the original.
4. Confirm visual explanations do not misread the code/diagrams. If vision is too slow, lower `MAX_VISION_FRAMES_PER_VIDEO`; or set `ENABLE_VISION=0` for OCR-only mode. After changes, reindex lectures.

Visual analysis uses **Gemma 3 4B** by default. Ollama supports base64 image messages in `/api/chat`. It is a best-effort model: captions may be inaccurate and the worker falls back to OCR if the model fails, unless `VISION_REQUIRED=1`.

### 2. Build the learning path

Choose a course in the **Course syllabus** panel and click **Build / refresh syllabus**. The system pulls sampled excerpts across completed lectures, requests a list of real topics from the local language model, then merges topics using exact/lexical matching and embedding cosine similarity. It keeps links to every merged lecture reference.

The de-duplication is approximate, not a guarantee that all paraphrases are equivalent. Review the path and rebuild after indexing new/modified lectures. Syllabus generation may take multiple minutes on CPU if the course contains many lectures.

### 3. Track learning and review

When you play a lecture, progress is saved to SQLite every ~12 seconds of playback movement and when the video ends. Opening a lecture from the library resumes near the saved point; opening a citation seeks to the cited point.

Select your course, enter a topic, and click **Generate 5 cards** in **Spaced repetition**. Click **Reveal answer**, self-rate `Again (0)`, `Hard (3)`, `Good (4)` or `Easy (5)`. These ratings determine the next due date through an SM-2 style scheduler. Use **Review due cards** on future days. This is *self-rated* active recall, not objective answer grading; check original sources for accuracy.

### 4. Run graded hands-on labs

1. Click a lab card in **Hands-on labs**, edit the starter file in the browser, and choose **Grade in Docker**.
2. A restricted container runs only the dedicated grader with the submitted files mounted **read-only**. Runtime options disable the network, root filesystem writes, additional Linux capabilities and privilege escalation, and set CPU, memory, process and timeout limits. The container is never given the Docker socket or production credentials.
3. Inspect the per-check pass/fail output and retry your solution. Workspaces are stored at `DATA_DIR/labs/workspaces/{session_id}`.

Available labs:

| Lab | File | Assessment |
|---|---|---|
| Python production error analysis | `solution.py` | Hidden test inputs and expected error counts |
| Shell HTTP access log analysis | `solution.sh` | Count HTTP 500–599 in stdin fixtures |
| Kubernetes resilient API | `manifest.yaml` | Parse valid YAML, verify replicas/labels/probe/resources/Service and reject host access |

An AI-suggested lab in the tutor is **not automatically executable**. Extend `app/labs.py` and `app/lab_graders/grade.py` to add further reviewed exercises and tests. Container isolation reduces risk but does not provide a guarantee against container/host kernel escape; do not treat it as suitable for untrusted internet users.

### 5. Optional Kubernetes API server validation

You do **not** need a Kubernetes cluster for the offline YAML lab grader. If you want stronger schema checks, install `kind` and `kubectl`:

```bash
brew install kind kubectl
python scripts/kind_lab.py create
```

Then set `ENABLE_KIND_LABS=1` in `.env` and restart the API. Select the Kubernetes lab, choose **Also perform dry-run...**, and grade. The API uses only `DATA_DIR/labs/kind-kubeconfig` with context `kind-courseforge-lab` and verifies that its API server is loopback-local. A provenance marker ensures the management script does not adopt an unrelated cluster. It performs `kubectl apply --dry-run=server` and **does not persist the resource**. Other contexts and `~/.kube/config` are never consulted by this lab.

Remove the owned cluster when finished:

```bash
python scripts/kind_lab.py destroy
```

Note: kind itself runs Kubernetes nodes as Docker containers. This is an isolated *development* cluster, not a hardened multi-tenant security boundary. Never provide cloud credentials, hostPath/privileged workload manifests or production network access to practice environments.

## Run tests

Fast tests (includes FFmpeg media extraction when FFmpeg is available):

```bash
python -m pytest -q
python -m compileall -q app scripts
node --check app/static/app.js  # if Node.js is installed
```

**Real-device end-to-end smoke test** (requires installed models/services and an actual video containing speech):

```bash
python scripts/doctor.py
curl -s -X POST http://127.0.0.1:8000/api/scan
curl -s http://127.0.0.1:8000/api/videos
# Copy an id from the returned video list:
python scripts/e2e_real.py --video-id "PASTE_VIDEO_ID_HERE"
```

The smoke test actually calls Faster-Whisper, FFmpeg, Tesseract, Gemma vision, Ollama embeddings, Qdrant search, the RAG tutor, syllabus generation and quiz generation. It writes index/card/syllabus state; use a small sample lecture first. The smoke test deliberately fails if vision was requested but could not generate a caption. It does not automatically create a kind cluster or silently run user-generated lab code.

The automated test suite mocks ML model inference and vector DB calls to remain fast and reproducible. This makes it possible to validate business logic without falsely claiming the real AI services worked.

## Configuration reference

| Variable | Default | What it controls |
|---|---|---|
| `COURSES_DIR` | `./courses` | Directory containing videos, read-only |
| `DATA_DIR` | `./data` | SQLite, transcripts, frames, labs and kubeconfig |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Local inference API |
| `QDRANT_URL` | `http://127.0.0.1:6333` | Local vector DB |
| `CHAT_MODEL` | `qwen3:4b-instruct` | Grounded tutor, syllabus, flashcards |
| `EMBED_MODEL` | `qwen3-embedding:0.6b` | Search and semantic topic de-duplication |
| `VISION_MODEL` | `gemma3:4b` | Code/slide/diagram screenshot descriptions |
| `ENABLE_VISION` | `1` | Switch vision captions on/off |
| `VISION_REQUIRED` | `0` | Fail processing when vision is unavailable |
| `MAX_VISION_FRAMES_PER_VIDEO` | `30` | Maximum frame descriptions per lecture |
| `WHISPER_MODEL` | `base` | Speech model; try `tiny` on weak CPUs |
| `WHISPER_DEVICE` | `cpu` | Use `cuda` where supported |
| `WHISPER_COMPUTE_TYPE` | `int8` | Whisper quantized CPU mode |
| `FRAME_INTERVAL_SECONDS` | `30` | Frame sampling interval |
| `MAX_FRAMES_PER_VIDEO` | `180` | Max extracted frames |
| `DISABLE_FRAMES` | `0` | Audio-only imports if set to 1 |
| `LAB_IMAGE` | `courseforge-lab:local` | Built hardened grader image |
| `ENABLE_KIND_LABS` | `0` | Optional project-owned kind dry-run |

## Privacy and limitations

- Keep FastAPI, Qdrant and Ollama bound to loopback. No user authentication is implemented; do not open the UI to the internet. Qdrant is loopback-bound in `compose.yaml`.
- Source videos may include secrets, names, personal information or copyrighted course material. Only use recordings you are entitled to process. Protect `DATA_DIR`, Qdrant's Docker volume and local model data.
- Screenshots are sampled, **not** analyzed frame-by-frame. Slides that appear between samples may be missed. Model explanations and OCR are fallible; check exact code and diagrams in the original lecture.
- The UI is single-user. It is not equipped with permissions, concurrent processing workers, autoscaling or distributed locks.
- Video formats like MKV might index correctly but may not play natively in a browser without a separate H.264 MP4 copy.
- Flashcard quality uses self-assessment. No AI grading of free-text answers is implemented.
- Curated Python/shell/Kubernetes labs are verified; arbitrary tutor-generated terminal commands are **never executed**.
- To rebuild vectors after changing `EMBED_MODEL`, re-create the Qdrant collection and reindex lectures. `docker compose down -v` deletes the saved search vectors. Back up beforehand.

## Developer guide

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the prior system design and [`docs/V2_IMPLEMENTATION.md`](docs/V2_IMPLEMENTATION.md) for all new service boundaries, SQLite schema changes, endpoints, safety controls, tests and next production-hardening tasks. FastAPI explorer: **http://127.0.0.1:8000/api/docs**.

## v3 interface refresh — CourseForge Learning Studio

The frontend now includes an Overview, searchable My Library, focused Learning Room, AI Tutor, Study Paths, Flashcards and Practice Labs. The prior v2 single-page markup did not contain all study panel controls required by its JavaScript; v3 restores those workflows with dedicated views. The interface has a **light/dark/system** theme switcher and **indigo/teal/rose** accents, saved locally in the browser.

There is **no frontend build step**. Run the same local FastAPI and worker commands from the installation section above, then refresh `http://127.0.0.1:8000/`. The theme controls are under the settings icon in the top bar. Use `/` to focus course search. Use **Scan courses** after configuring `COURSES_DIR`; nested lecture folders remain part of their top-level course folder.

To review UI architecture, breakpoints and design tokens, see [`docs/UI_V3.md`](docs/UI_V3.md).

This is an original local-course interface informed by common patterns from Coursera and Udemy. It is not an integration with either service and cannot fetch protected courses from those platforms. All course videos must already be present on disk with appropriate access rights.

## P0 end-to-end acceptance gate

For a real-device confidence check before deploying this release, use the [P0 validation runbook](docs/P0_VALIDATION.md). Run `python scripts/validate_local.py --video-id "VIDEO_ID" --lab-smoke --real-inference` after indexing a short lecture. It verifies local service readiness, HTTP Range playback, source timestamps and notes, a restricted Docker grader, and genuine Whisper/Ollama/Qdrant processing. Live AI/model checks **cannot run in GitHub-hosted CI** and must be completed with your own video files and local models. Do not merge solely on the basis of the mocked-model CI suite.

## P1: Edit local course details and covers

Open **Library → Edit details** on a course card to edit its title, instructor, category, tags, or cover image. Course covers are generated from video frames when possible and cached under `DATA_DIR/covers`. Custom images are stored locally after validation and re-encoding; there are no external thumbnail downloads or invented metadata. Library filters/search respect saved categories and tags. Original folder names remain the stable internal course IDs, so saved lesson progress and source references are preserved.

API and testing details: [`docs/P1_COURSE_CATALOG.md`](docs/P1_COURSE_CATALOG.md).

## P1 Step 4: Topic-level assessments

Under **Learning → Study paths**, select a saved multi-course roadmap and click **Assess this topic**. CourseForge generates a short, source-linked multiple-choice knowledge check from indexed lecture excerpts via your local Ollama model. Complete the questions to see deterministic grading, feedback, suggested video timestamps and your latest per-topic practice signal. Results and attempt history persist in SQLite. Quiz scores do **not** automatically complete roadmap steps, and AI-authored explanations may require verification against the original recording. No questions are invented when course excerpts or the local model are unavailable.

Read [P1_MASTERY_ASSESSMENTS.md](docs/P1_MASTERY_ASSESSMENTS.md) for endpoints, data model, test coverage, and live-device acceptance steps.

## P1 Step 5: Expanded practical lab tracks

There are eight pre-reviewed exercises. SQL runs fixture-based SELECT queries in a disposable in-memory SQLite database inside restricted Docker. PySpark runs local DataFrame fixtures inside an optional Java + PySpark grading image. Python API request handling and the existing Python and shell exercises use hidden functional fixtures. Dockerfiles and Ansible playbooks are examined with deterministic **static checks only**—their image is not built and their playbook is not executed.

Build the standard image and separate PySpark image as shown above. Configure `LAB_IMAGE` and `LAB_SPARK_IMAGE` if necessary. PySpark grading has 2 GiB/2 CPU limits and 120-second timeout, and all labs prohibit networking, extra capabilities, privilege escalation and writable workspace bind mounts. The UI shows type/level and filters by subject.

**Safety limit:** The grader containers share the local host kernel. They are not hardened isolation for untrusted remote users. Do not expose this single-user FastAPI instance to the public internet. No generated command runs outside the reviewed lab templates. See [`docs/P1_LAB_TRACKS.md`](docs/P1_LAB_TRACKS.md) for grading contracts, fixtures, and real-device smoke tests.

## Adaptive practice — P1 Step 6

The **Study Paths** view now recommends curated labs for topics where your latest concept-check result indicates a gap. Recommendations use deterministic topic matching and separately track graded lab attempts, without claiming that a passed exercise proves concept mastery. The **Labs** view includes a saved-path selector, prioritized exercises, and append-only history of verified grader results. A failed attempt raises retry priority; a pass leads to a recommendation to reassess the concept. Unsupported topics do not receive fabricated labs.

See [`docs/P1_ADAPTIVE_PRACTICE.md`](docs/P1_ADAPTIVE_PRACTICE.md) for API, safety, rubric, and test details. Live Docker/PySpark checks remain an explicit local acceptance requirement.

## Seven-day adaptive calendar (v3 P1 Step 8)

Open **Today's plan → Your next 7 days**. Configure per-weekday study minutes (0 for rest), select your existing roadmap and click **Build / refresh week**. Each day links to its saved study checklist; enter actual minutes after a session to compare what you planned with self-reported study time. Spaced-repetition reviews are forecast based on card due dates and your local time offset, then deferred to the next selected study day. The calendar never marks a topic mastered on the strength of a checklist. See [weekly calendar design and limitations](docs/P1_WEEKLY_CALENDAR.md).