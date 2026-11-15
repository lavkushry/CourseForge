# Worker 07 — PostgreSQL Isolation & Data Integrity

Read [`../CONTRACT.md`](../CONTRACT.md) first.

## Scope (touch only)

- `backend/internal/career/*.go` SQL strings (prefer fixing queries in place)
- Migrations only if a schema gap blocks isolation: `backend/internal/store/migrations/015_career_studio.sql`, `backend/internal/store/migrations/035_universal_career_profiles.sql` (and newer career migrations if clearly required)

## Task

Audit and fix career SQL so user-owned reads/writes enforce `user_id` binding. Preserve composite keys / pacing isolation / mutation provenance where they already exist.

## Rules

- Prefer query fixes over broad refactors
- Do not drop columns or rewrite unrelated migrations
- Do not run full E2E; Cursor runs `./scripts/muse_verify.sh --go`
- If already satisfied, list representative scoped queries with file:line evidence and make **zero edits**

## Completion criterion

No known unscoped user-data query remains in the files you inspected; summary of fixes (or no-op evidence).
