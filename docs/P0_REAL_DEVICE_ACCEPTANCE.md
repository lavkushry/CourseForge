# P0: Real-device end-to-end acceptance (Step 10)

This is a **Mac/Linux host-run acceptance gate**, not a claim that CI has run on your laptop. It executes direct HTTP checks against your **running local CourseForge** and optionally invokes real Chromium, real Whisper/Ollama/Qdrant models, and curated Docker grading. The GitHub Actions job only runs fixture-based deterministic regression tests, without those runtime services.

## Prerequisites

1. Check out `test/real-device-e2e-acceptance` (after reviewing this change), use Python 3.12, and install `requirements.txt` in your virtual environment.
2. Point `COURSES_DIR` and `DATA_DIR` in `.env` at your actual local directories. Keep the API bound to `127.0.0.1`, not `0.0.0.0`; CourseForge has no multiuser authentication.
3. Start Ollama with the models named in `.env`, start Qdrant (`docker compose up -d`), and start CourseForge (`uvicorn app.main:app --host 127.0.0.1 --port 8000`) and the worker (`python -m app.worker`).
4. In the UI, scan a representative **legitimately available local course lecture with audible speech**. Wait for its status to be `done`.
5. Copy the lecture's *video ID* from `http://127.0.0.1:8000/api/videos`, **not** a local filesystem path.
6. For browser acceptance, `pip install playwright && python -m playwright install chromium`. Chromium decoding is codec-sensitive: an `.mkv` containing incompatible streams may pass HTTP byte ranges but fail browser playback. Test with browser-compatible MP4/H.264/AAC when possible.
7. For Docker acceptance, build the vetted grader image (`docker build -f docker/lab.Dockerfile -t courseforge-lab:local .`). Optional Spark grader has a separate image and is **not** included in this single-lab smoke.

## Acceptance sequence

Start without persistent changes:

```bash
python scripts/acceptance_live.py
```

Run the local lecture, notes, and focus timer probes (notes are deleted afterward; the probe focus session is **cancelled**, and does not contribute to learning analytics):

```bash
python scripts/acceptance_live.py --video-id YOUR_VIDEO_ID --focus
```

Run the full opt-in gate on the actual machine:

```bash
python scripts/acceptance_live.py \
  --video-id YOUR_VIDEO_ID \
  --focus --docker-lab --real-ai --browser \
  --json-output ./data/acceptance-report.json
```

`--real-ai` runs the existing `e2e_real.py` with `--fresh-transcript`: transcription, frame enrichment, real embeddings into Qdrant, source-grounded tutoring, syllabus generation and flashcards. **It reindexes the selected lecture** and generates actual learner artifacts. Use a disposable representative course in a separate test data directory if you do not want those changes in your normal library. This option is off by default. Model work can be slow.

`--docker-lab` creates one actual lab session and grades a fixed, reviewed Python submission inside the restricted container. **The session is retained** as a test artifact. Neither lab option launches arbitrary model-produced commands or runs Ansible/Dockerfile submissions on the host. The focus probe will not interrupt an existing active or paused learner session: its check is `SKIP` in that case.

`--browser` launches an actual local headless Chromium, navigates Dashboard → Library → Planner, checks uncaught JavaScript errors and, when `--video-id` is supplied, exercises the real browser decoder and seek. To retain a local screenshot, add `--screenshot-dir ./data/acceptance-screenshots` (may capture your course titles; **never commit or upload screenshots** without reviewing them).

## Interpreting results

Each check prints `PASS`, `FAIL`, or `SKIP`. SKIP means *not exercised*, not success. The script exits nonzero if any check fails or if none pass. It reports only check names and generic failure categories; it never intentionally puts raw lecture transcripts, credentials, filesystem paths, model responses, or local service URLs into JSON reports. Do **not** commit `.env`, courses, `data/` or reports to GitHub.

| Capability | Meaningful proof |
|---|---|
| FastAPI | Running HTTP `/api/health` returns success |
| Indexed source | `GET /api/videos/{id}` has a completed lecture and timestamped chunks |
| HTTP playback | `Range: bytes=0-63` returns 206 and a valid `Content-Range` |
| Browser playback | Chromium loads lecture metadata and completes a nonzero seek; separate from 206 |
| Notes | Probe note saved, read back with correct timestamp, then deleted |
| Focus | New linked session starts, pauses, resumes and is cancelled; existing sessions untouched |
| Docker | Fixed known-good solution is graded in the local sandbox with actual per-check output |
| Local AI | Fresh Whisper, Ollama/Qdrant indexing, grounded tutor, syllabus and cards complete |

## Known limitations / go/no-go

- The programmatic focus probe validates the server lifecycle, **not actual human attention**, and cancels its own session. Manually confirm the on-screen clock counts up/down appropriately, stays paused across a reload, and that a **finished** focus interval appears in analytics after a real study session. No script simulates sustained attention.
- Browser smoke does not prove every lesson format is browser-playable. Check a few actual videos with different codecs and timestamp links manually.
- Source-grounded model replies and caption accuracy still need manual sampling; automated checks prove sources are present, not that every answer is truthful.
- The real-model pipeline may fail on videos without speech, cold model downloads, incompatible model tags, slow CPU devices, or missing Qdrant. Treat as a failure needing diagnosis, not as a mock-data pass.
- CI can only guarantee that code and its fixture-backed tests work; a **real-device gate is pending until the command is executed on the destination Mac** and its report reviewed.

**Release gate:** merge only after CI passes *and* the full real-device command passes on the intended installation, plus a manual video/timer/lab UX check. This PR is test tooling and docs, not a change to the actual inference or sandbox safety boundaries.