# CourseForge P0 — Local end-to-end validation

The automated acceptance test covers the actual FFmpeg video decoder, video HTTP Range seeking, SQLite course/lesson persistence, timestamped notes, lesson progress, source-linked tutor API shape, and restricted lab-container flags. **The tests mock speech/model inference and Docker execution; a green GitHub CI run alone is not proof that your hardware can run Whisper, Ollama, Qdrant, or the Docker grader.**

## Before you run

On your Mac, install Python dependencies, `ffmpeg`, `ffprobe`, `tesseract`, Docker Desktop, and Ollama as described in the README. Download the required language, embedding, and vision models. Start Qdrant with `docker compose up -d`. Build the grader image:

```bash
docker build -f docker/lab.Dockerfile -t courseforge-lab:local .
```

Set `COURSES_DIR` to a folder with **one short video lecture you are authorized to process**. Keep `DATA_DIR` private. Start the app and worker in separate terminals:

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8000
python -m app.worker
```

## Run validation, in order

1. Import one course using **Scan Library** and wait for a `done` processing status. Record the `id` from `GET /api/videos`.
2. Run the environment preflight (checks endpoints, required model tags, and binaries):

   ```bash
   python scripts/validate_local.py
   ```

3. Verify indexed source timestamps, playback byte-range seeking, and timestamped note create/read/delete. The temporary validation note is automatically removed:

   ```bash
   python scripts/validate_local.py --video-id "VIDEO_ID"
   ```

4. Verify a fixed known-good Python solution in the **restricted** Docker lab runner (creates a local test lab session; does not execute tutor-generated commands):

   ```bash
   python scripts/validate_local.py --video-id "VIDEO_ID" --lab-smoke
   ```

5. Exercise **genuine** Whisper, local vision/OCR, Ollama embeddings/chat, Qdrant, syllabus, and flashcards. This can take substantial local compute and it updates that lecture's index and study data. `--fresh-transcript` is passed automatically so Whisper actually transcribes instead of reading a cached result:

   ```bash
   python scripts/validate_local.py --video-id "VIDEO_ID" --real-inference --json-output "$HOME/courseforge-p0-report.json"
   ```

An acceptance check returns a non-zero exit code on failure. The JSON report is saved locally **only** if `--json-output` is set; it is not uploaded anywhere. The live AI test checks that responses and source references exist, but it cannot guarantee their factual correctness: compare generated text and timestamps to the original recording manually. For playable browser formats, prefer H.264/AAC MP4; MKV and some codecs may be unsupported by your browser even if FFmpeg indexes them.

## Scope / trust boundaries

- The UI, API, Ollama, and Qdrant should run on loopback only. Do not expose this unauthenticated prototype on the internet.
- Test code does **not** send local lecture data to Coursera, Udemy, or any hosted AI service when configured with local Ollama and Qdrant endpoints.
- Live validation creates a few study artifacts and lab sessions in `DATA_DIR`; it does not modify source videos. The optional `--fresh-transcript` deletes only the selected lecture's cached transcript, which is immediately regenerated.
- Kubernetes kind validation remains opt-in and must run only against the project-managed cluster.
- If a test fails, keep the PR under review and use the individual PASS/FAIL output to identify the missing service or incorrect model configuration.

## CI evidence

```bash
python -m pytest -q
python -m compileall -q app scripts
node --check app/static/app.js
node --check app/static/services.js
```

CI runs all reproducible tests but **does not** run live inference or Docker grading. Real hardware validation remains a separate P0 acceptance gate before merging the release.