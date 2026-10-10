# CourseForge v3 — Release readiness and decision record (Step 11)

**Scope:** local, single-user CourseForge v3. This gate is a reviewer aid, not evidence that someone ran the system on your Mac. Both passing CI and a full acceptance run on the intended installation are necessary.

## Automated checks

GitHub CI runs Python compilation, frontend JavaScript syntax, Pytest and the tracked-file audit. The audit blocks accidentally committed courses, databases, credentials and local acceptance reports. CI cannot validate your local Ollama, Whisper, Docker or real video codec support.

## Full acceptance on your Mac

Check out the exact proposed Git revision. Keep the service bound to loopback; use a disposable course library if you do not want the AI probe to reindex your own lecture.

    python scripts/acceptance_live.py --video-id YOUR_INDEXED_VIDEO_ID --focus --docker-lab --real-ai --browser --json-output ./data/acceptance-report.json
    python scripts/release_gate.py --audit-tree --report ./data/acceptance-report.json --expected-commit "$(git rev-parse HEAD)"

The gate requires 20 named checks to pass, with no skipped or failed checks, a valid report schema, correct matching summary, a real timezone-aware UTC timestamp no older than 72 hours, and an exact full Git commit SHA. A health-only diagnostic PASS cannot approve the release. You can change age tolerance with --max-age-hours (1–168). The JSON report stays private in data/.

Report metadata is not cryptographically authenticated. A reviewer must witness the local run and verify revision and environment.

## Manual release checklist

- Try three real lectures with different codecs and confirm seek, transcript link position and explanations against the source.
- Sample tutor and OCR/vision statements against authentic lectures, including code or diagrams.
- Check prerequisite path, quiz, review queue and correct citations. Verify restart persistence.
- Run known-good and known-bad Docker graders. Build the separate Spark image if that track is required.
- Pause and resume the timer through navigation and reload, then complete a real focus session and verify analytics. Cancelled probes must not count.
- Confirm API binds only to 127.0.0.1. Back up the SQLite database before upgrading; never commit .env, data, videos, transcripts or screenshots.

## GO / NO-GO

GO for a local v3 release requires CI on the proposed revision, a full matching real-device acceptance report, all manual checks and reviewer approval. Otherwise NO-GO. The gate does not merge code, create a release tag, certify the sandbox or prove attention/model correctness. See docs/P0_REAL_DEVICE_ACCEPTANCE.md for troubleshooting.
