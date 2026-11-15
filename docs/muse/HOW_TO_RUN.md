# How to run Muse on CourseForge (surgical slices)

Do **not** paste `MUSE_REFACTOR_PROMPT.md` or `MUSE_10_WORKER_SWARM.md` as a single prompt. Those burn credits on whole-system audits. Use one worker file at a time.

## Preconditions

1. `cd /home/ubuntu/CourseForge`
2. Check allowance: `muse usage` — wait if Everyday Usage is over 100%
3. Read [`CONTRACT.md`](CONTRACT.md) once per session

## Standard invocation

```bash
cd /home/ubuntu/CourseForge
muse exec \
  --workspace /home/ubuntu/CourseForge \
  --trust-workspace \
  --disable-sandbox \
  --model muse-wonder-1.0 \
  --reasoning-effort high \
  --prompt-file docs/muse/workers/01-ui-design-system.md
```

Check `muse usage` first. Everyday Usage at ≥100% returns API 429 until the window resets.

### Why these flags

| Flag | Reason |
| --- | --- |
| `--workspace /home/ubuntu/CourseForge` | Last wasted run used `~` (`trusted · not found`) |
| `--trust-workspace` | Without it Muse skips `AGENTS.md` and agent delegation |
| `--disable-sandbox` | Host `bwrap` lacks `--ro-bind-symlink`; Muse helper under `/home/ubuntu` cannot sandbox |
| `--prompt-file …` | Keeps scope surgical; one worker per run |
| `muse-wonder-1.0` + `high` | Enough for polish; avoid megaprompt + max effort |

Re-enable sandbox only after Muse is installed outside `/home/ubuntu` and a capable system `bwrap` is on `PATH`.

## Worker order (recommended)

1. `01-ui-design-system.md` or `04-ui-isolation.md` (lowest risk)
2. `02-ui-engine.md` → `03-ui-studio.md`
3. `05-go-api.md` → `06-go-vault.md` → `07-go-db.md`
4. `08-python-adapters.md` → `09-python-bandit.md`
5. Worker 10 is **not** a Muse prompt — Cursor runs `scripts/muse_verify.sh --all`

## After each Muse slice

```bash
# UI slice
./scripts/muse_verify.sh --web

# Go slice
./scripts/muse_verify.sh --go

# Python slice
./scripts/muse_verify.sh --worker

# Before shipping / declaring done
./scripts/muse_verify.sh --all
```

Summary lands in `tmp/muse_verify_last.json`. Recorded baselines live in [`BASELINE.md`](BASELINE.md). On failure, fill [`PATCH_BACK.md`](PATCH_BACK.md) and re-run Muse with that file only.

The harness auto-picks Postgres on `127.0.0.1:5432` or compose-mapped `:15439`. Override with `CF_TEST_DATABASE_URL` when needed.

## Interactive TUI (optional)

```bash
cd /home/ubuntu/CourseForge
muse --workspace /home/ubuntu/CourseForge --trust-workspace --disable-sandbox \
  --model muse-wonder-1.0 \
  "Read docs/muse/CONTRACT.md and execute docs/muse/workers/01-ui-design-system.md"
```
