# Worker 06 — Profile Onboarding & Auth Vault

Read [`../CONTRACT.md`](../CONTRACT.md) first.

## Scope (touch only)

- `backend/internal/career/profile_onboarding.go`
- `backend/internal/career/auth_vault.go`
- `backend/internal/career/engine_control.go`

## Task

Surgical hardening:

- AES-256-GCM vault encrypt/decrypt on demand; never log secrets
- Session/cookie decrypt scoped by `user_id` + platform
- Preserve pre-flight readiness concepts (`ProfileReady`, `WhitelistReady`, `AuthReady`) if present
- Resume/PDF parsing stays bounded; no secret leakage in errors

## Rules

- Do not run full E2E; Cursor runs Go verify
- If already satisfied, cite evidence and make **zero edits**

## Completion criterion

Vault and readiness gates remain correct and secret-safe; summary (or no-op).
