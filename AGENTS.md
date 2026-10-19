# CourseForge working guidance

For the Go backend, TypeScript player, Odysee integration, concurrency or rewrite
migration, read `docs/GO_TYPESCRIPT_REWRITE_PLAN.md` first. Read
`docs/GO_TYPESCRIPT_CAPACITY.md` before setting performance defaults, running load
tests or claiming learner capacity. Read `docs/GO_TYPESCRIPT_AGENTS.md` when assigning
parallel implementation work or choosing project skills.

Preserve existing uncommitted work. Use synthetic fixtures or isolated snapshots for
tests; do not create load-test accounts in production. Keep Odysee credentials out of
browser responses and logs. Preserve learner isolation and playback ownership.

The 10,000-concurrent-learner figure is a target until scoped measurements prove it.
Report API capacity, media delivery and AI job throughput separately.

## Cursor Cloud specific instructions

Ordinary commands stay in the README rewrite section and `.github/workflows/`. This environment differs in a few ways that are easy to miss.

- PostgreSQL 16 is native (`pg_ctlcluster`; pid 1 is not systemd). Compose's Postgres 18 and Docker are not started. Role `courseforge` owns database `courseforge_rewrite` on `127.0.0.1:5432`, using the local compose password from `compose.rewrite.services.yaml`. Export `CF_TEST_DATABASE_URL=postgresql://courseforge:local_rewrite_only@127.0.0.1:5432/courseforge_rewrite?sslmode=disable` before `go test`. Tests create `cf_test_*` schemas. The `pgvector` extension is not installed; the rewrite migration continues without it. If Postgres runs out of connections, rerun with a lower `go test -p`.
- Go 1.26.9 is `/usr/local/bin/go`. `/usr/bin/go` is 1.22 and cannot build `backend/`. `golangci-lint` 2.14.0 is on `/usr/local/bin`.
- Node for `web/` is 22.23.3 at `/usr/local/bin/node` (nvm path `/home/ubuntu/.nvm/versions/node/v22.23.3/bin`). A Cloud Agent shell may resolve bare `node` to `/exec-daemon/node` (22.14). Put the 22.23.3 bin first for lint, typecheck, vitest, and Vite.
- Python is `/workspace/.venv`. From `eval/knowledge`, run `PYTHONPATH=. /workspace/.venv/bin/python -m harness` and `PYTHONPATH=. /workspace/.venv/bin/python -m pytest -q`. Playwright Chromium and WebKit are installed. `.github/workflows/tests.yml` skips `tests/test_ui_contract.py` and `test_admin_engagement_metrics_render_in_overview`; those fail on current main for product assertions.
- Boot sessions (tmux, loopback only): `academy` uvicorn on `:8000` (`REGISTRATION_MODE=open`, `COOKIE_SECURE=0`), `rewrite-api` `go run ./cmd/api` on `:18090`, `web` Vite on `:5173` with `COURSEFORGE_API_URL=http://127.0.0.1:18090`. Re-running start leaves existing sessions up and waits for `/api/health`, `/health/live`, and the Vite port.
- Ollama, Qdrant, Docker lab graders, and Odysee credentials are not in this environment. Do not pull models or start Docker for API, player, or unit-test work. Real-device acceptance stays on a machine that has those services.
