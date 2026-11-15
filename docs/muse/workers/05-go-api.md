# Worker 05 — Career Domain & REST API

Read [`../CONTRACT.md`](../CONTRACT.md) first.

## Scope (touch only)

- `backend/internal/career/service.go`
- `backend/internal/career/handlers.go`
- `backend/internal/career/domain.go`
- Closely related helpers only if required for a compile-safe fix in those files

## Task

Surgical hardening:

- Keep domain services decoupled from HTTP transport
- Handlers authenticate via principal and delegate; use `httpx.Error` / `httpx.JSON` / `httpx.Decode`
- Prefer atomic transaction wrappers for multi-step writes already in these files
- Do not invent new endpoints unless fixing a clear broken contract in-scope

## Rules

- Do not run full E2E; Cursor will run `./scripts/muse_verify.sh --go`
- If already satisfied, cite evidence and make **zero edits**

## Completion criterion

Transport stays thin; errors use httpx helpers; no unscoped user data access introduced; summary (or no-op).
