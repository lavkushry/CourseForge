# Muse harness baseline (recorded, not invented)

Source of truth: `tmp/muse_verify_last.json` after `./scripts/muse_verify.sh`.

## 2026-11-01T15:45Z–15:47Z (`./scripts/muse_verify.sh --all`)

| Gate | Result | Counts | Notes |
| --- | --- | --- | --- |
| go | pass | 3 packages ok | `go1.26.8` via PATH; `CF_TEST_DATABASE_URL` auto-detected to `127.0.0.1:15439` |
| web | pass | build ok | Node 22.23.3 bin first |
| worker | pass | 14 passed | `/home/ubuntu/Resume/.venv` |
| e2e | fail | **378 passed / 6 failed** | Not 382/382. Meta-tests invoke pytest with hard-coded Mac path `/Users/lavkushkumar/Desktop/Courses/CourseForge/...` (tier1/tier2 F15 worker-pytest). Direct `pytest tests/career_e2e` showed 378 passed / 4 failed. |

Do **not** tell Muse the suite is 382/382 green until Cursor harness shows it.

```bash
cd /home/ubuntu/CourseForge
./scripts/muse_verify.sh --all
cat tmp/muse_verify_last.json
```

## First Muse slice attempt (Worker 04)

- `muse exec … --prompt-file docs/muse/workers/04-ui-isolation.md` returned **API 429** (Everyday Usage 110%; resets `2026-11-01T19:44:52Z`).
- Cursor stood in for Worker 04: isolation already satisfied — `web/src/tutor/view.ts` `courseforge_tutor_history_${account.id}`, `web/src/settings/view.ts` `courseforge_daily_goal_${account.id}`, `web/src/career/view.ts` `courseforge_career_tasks_${uid}_${day}`; theme/accent remain device-global. **Zero code edits.**
- Re-run Muse after quota reset with `--trust-workspace` (see `HOW_TO_RUN.md`), then `./scripts/muse_verify.sh --web`.
