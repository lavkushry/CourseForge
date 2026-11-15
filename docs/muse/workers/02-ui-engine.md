# Worker 02 — Autonomous Engine Tabs

Read [`../CONTRACT.md`](../CONTRACT.md) first.

## Scope (touch only)

- `web/src/career/view.ts` (engine views only: Goal/CRM, Daily Plan, Boost, App Ledger)
- `web/src/career/style.css` only if a class the engine views need is missing

## Task

Surgical polish for the 4 engine views:

1. Goal & CRM — pacing gauge, bottleneck banners, recruiter CRM clarity
2. Daily Plan — three blocks (Morning Apply, Afternoon Outbound, Evening Sweep)
3. Profile SEO (Boost) — bandit scores, keyword utility, mutation audit readability
4. App Ledger — filters, status pills, CSV export affordance

Preserve existing API wiring and per-user task checklist isolation.

## Rules

- Do not rewrite the whole file; prefer localized markup/class fixes
- Do not run E2E or deploy
- If already satisfied, cite evidence and make **zero edits**

## Completion criterion

Engine views remain navigable and readable under the contract aesthetic; no isolation regressions; summary of files changed (or no-op).
