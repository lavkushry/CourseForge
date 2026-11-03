# Contributing to CourseForge

Thanks for your interest — contributions, bug reports and honest feedback are
all welcome.

## Getting started

1. Read the [README](README.md) quickstart and the full
   [Install guide](README.md#install--first-run) to run the Python Academy app.
2. For the Go backend / TypeScript player, use the commands in
   [Rewrite development commands](README.md#rewrite-development-commands-go--typescript)
   and read [`AGENTS.md`](AGENTS.md) plus `docs/GO_TYPESCRIPT_REWRITE_PLAN.md`
   before making changes there.
3. Look for issues labelled
   [`good first issue`](https://github.com/lavkushry/CourseForge/labels/good%20first%20issue)
   if you want a scoped place to start.

## Ground rules

- **Preserve learner isolation and playback ownership.** Per-user data must
  stay per-user; this is a core product guarantee, not a nicety.
- **Keep credentials out of code, logs and browser responses** — especially
  Odysee and hosting credentials. Never commit `.env` files, session files or
  course-data dumps.
- **Use synthetic fixtures or isolated snapshots for tests.** Do not create
  load-test accounts in a production deployment, and only process recordings
  you are entitled to use.
- Run the relevant test suites before opening a PR:
  - Python: the suite described in [Run tests](README.md#run-tests)
  - Go: `go vet ./... && go test ./...` in `backend/`
  - Web: `npm run lint && npm run typecheck && npx vitest run` in `web/`
- Capacity figures are targets until scoped measurements prove them; please
  don't state them as measured results (see `AGENTS.md`).

## Pull requests

- Keep PRs focused; describe the user-visible change and how you tested it.
- Add or update tests for behavior changes, and docs for user-facing changes.
- If you are planning something large, open an issue first so we can agree on
  the approach before you invest the time.
