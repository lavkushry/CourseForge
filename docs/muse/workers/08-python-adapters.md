# Worker 08 — Stealth Playwright Adapters

Read [`../CONTRACT.md`](../CONTRACT.md) first.

## Scope (touch only)

- `services/career_worker/adapters/naukri_adapter.py`
- `services/career_worker/adapters/linkedin_adapter.py`
- `services/career_worker/adapters/simulation_adapter.py`
- Adapter package `__init__.py` only if export wiring requires it

## Task

Surgical hardening:

- Multi-tenant cookie/session paths: `cookies/<user_id>/<platform>_cookies.json`
- Keep SimulationAdapter as resilient dry-run / fallback path
- Do not weaken lock/health behavior owned by `app.py` unless a one-line call-site fix is required (prefer staying in adapters/)

## Rules

- Do not run full E2E; Cursor runs `./scripts/muse_verify.sh --worker`
- If already satisfied, cite evidence and make **zero edits**

## Completion criterion

Adapters remain tenant-isolated with simulation fallback intact; summary (or no-op).
