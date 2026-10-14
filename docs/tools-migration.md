# Tools layout migration (proposal only)

**Do not apply this migration on the live host yet.** Cron and a running
`uvicorn` load paths from `/home/ubuntu/CourseForge` today. Moving or editing
`watchdog.sh`, `linux_pipeline.py`, `monitor_status.py`,
`scripts/rebalance_odysee_wallets.py`, `app/`, `scripts/`, `data/`, or JSON
manifests while those jobs run will break production pipeline work.

This document proposes a future `tools/` layout and the exact path updates to
perform in a rehearsed maintenance window.

## Current live paths

Observed crontab (host) and in-repo entrypoints:

| Job | Schedule | Current command / path |
| --- | --- | --- |
| Watchdog | `*/2 * * * *` and `@reboot` | `/home/ubuntu/CourseForge/watchdog.sh` |
| Night monitor | `*/10 * * * *` | `python3 /home/ubuntu/CourseForge/monitor_status.py` |
| Wallet rebalance | `0 * * * *` | `python3 /home/ubuntu/CourseForge/scripts/rebalance_odysee_wallets.py` |
| Pipeline (via watchdog) | on demand | `/home/ubuntu/CourseForge/linux_pipeline.py` |
| Academy API | systemd / manual | `uvicorn app.main:app` with cwd `/home/ubuntu/CourseForge` |

`watchdog.sh` hard-codes:

- `DIR="/home/ubuntu/CourseForge"`
- `SCRIPT="$DIR/linux_pipeline.py"`
- `CURRICULA="$DIR/new_5_curricula.json"`
- `MANIFEST="$DIR/data/odysee_manifest.json"`

`monitor_status.py` hard-codes `ROOT = Path('/home/ubuntu/CourseForge')` and the
same curricula/manifest/DB paths under `data/`.

## Proposed layout

Keep the FastAPI package at `app/` (import path and uvicorn target unchanged).
Move **ops-only** root scripts into `tools/`:

```text
tools/
  README.md                 # how to run ops jobs; link back to this doc
  watchdog.sh               # from ./watchdog.sh
  linux_pipeline.py         # from ./linux_pipeline.py
  monitor_status.py         # from ./monitor_status.py
  rebalance_odysee_wallets.py  # from ./scripts/rebalance_odysee_wallets.py
```

Leave in place (not part of this move):

- `app/` — live uvicorn module
- `scripts/` — developer/CI helpers (`doctor.py`, `release_gate.py`, …) unless
  individually promoted later
- `data/`, `courses/`, `*.json` manifests — runtime state; never relocate casually
- `backend/`, `web/` — Go/TypeScript rewrite

Optional later: `tools/pipeline/` if more Odysee batch upload helpers join the
ops set (`odysee_batch_upload.py`, curriculum builders). Those stay at repo root
until explicitly scheduled.

## Exact path updates required

### 1. File moves (maintenance window only)

```bash
cd /home/ubuntu/CourseForge
mkdir -p tools
git mv watchdog.sh tools/watchdog.sh
git mv linux_pipeline.py tools/linux_pipeline.py
git mv monitor_status.py tools/monitor_status.py
git mv scripts/rebalance_odysee_wallets.py tools/rebalance_odysee_wallets.py
```

### 2. In-file path constants (edit after move)

| File | Change |
| --- | --- |
| `tools/watchdog.sh` | Keep `DIR="/home/ubuntu/CourseForge"` as repo root; set `SCRIPT="$DIR/tools/linux_pipeline.py"`; keep curricula/manifest under `$DIR` / `$DIR/data` |
| `tools/monitor_status.py` | Keep `ROOT = Path('/home/ubuntu/CourseForge')`; change any assumptions that the script lives at repo root (e.g. log paths stay under `ROOT`); update `pgrep -f` pattern to `tools/linux_pipeline.py` **or** keep matching `linux_pipeline.py` if the basename remains unique |
| `tools/rebalance_odysee_wallets.py` | Resolve repo root as `Path(__file__).resolve().parents[1]` if it currently assumes `scripts/` nesting (`parents[1]` vs `parents[2]`) |

### 3. Crontab replacements

Replace the live crontab entries with:

```cron
*/2 * * * * /home/ubuntu/CourseForge/tools/watchdog.sh
@reboot /home/ubuntu/CourseForge/tools/watchdog.sh
*/10 * * * * python3 /home/ubuntu/CourseForge/tools/monitor_status.py >> /home/ubuntu/CourseForge/night_monitor.log 2>&1
0 * * * * python3 /home/ubuntu/CourseForge/tools/rebalance_odysee_wallets.py >> /home/ubuntu/CourseForge/rebalance.log 2>&1
```

Install with `crontab -e` only after the files exist at the new paths and a
manual dry-run of each command succeeds.

### 4. Process / pgrep continuity

Before removing the old paths:

1. Stop or let the current `linux_pipeline.py` finish a safe checkpoint.
2. Confirm `pgrep -af linux_pipeline` and watchdog logs.
3. Start once via `tools/watchdog.sh` and verify a new PID and log append.
4. Then remove any temporary compatibility symlinks if you added
   `linux_pipeline.py -> tools/linux_pipeline.py` during dual-run.

Compatibility symlinks at the old locations are recommended for one release if
any external docs or operators still call the root paths.

## Out of scope

- Do not move `app/` or change the uvicorn module path in this migration.
- Do not relocate `data/*.sqlite3`, Odysee manifests, or `courses/`.
- Do not edit these scripts in the deploy/CI refactor workstream; this file is
  the proposal only.

## Verification checklist (when someone applies the move)

- [ ] `tools/watchdog.sh` exits 0 when the pipeline is already running
- [ ] `tools/watchdog.sh` relaunches `tools/linux_pipeline.py` when work remains
- [ ] `tools/monitor_status.py` appends a status line to `night_monitor.log`
- [ ] `tools/rebalance_odysee_wallets.py --help` or a dry-run path succeeds
- [ ] Crontab matches the four entries above
- [ ] `uvicorn app.main:app` still starts from the repo root
