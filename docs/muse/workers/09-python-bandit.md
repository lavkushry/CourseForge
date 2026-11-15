# Worker 09 — LinUCB Bandit & Recruiter CRM Engine

Read [`../CONTRACT.md`](../CONTRACT.md) first.

## Scope (touch only)

- `services/career_worker/modules/` (especially boost policy / mutator / keyword / pacing / CRM modules under this tree)

## Task

Surgical correctness polish:

- LinUCB contextual bandit with dimension `d=7` and exploration alpha consistent with existing module defaults
- Preserve update rules \(A \leftarrow A + xx^T\), \(b \leftarrow b + rx\)
- Keep mutation whitelist/blacklist guards and CRM note/follow-up cadence behavior coherent

## Rules

- Do not retune production defaults without evidence in-module comments/tests
- Do not run full E2E; Cursor runs `./scripts/muse_verify.sh --worker`
- If already satisfied, cite evidence and make **zero edits**

## Completion criterion

Bandit/CRM modules match contract math and guards; summary (or no-op).
