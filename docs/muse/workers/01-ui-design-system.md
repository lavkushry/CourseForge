# Worker 01 — UI Design System & Tokens

Read [`../CONTRACT.md`](../CONTRACT.md) first.

## Scope (touch only)

- `web/src/career/style.css`

## Task

Surgical polish for Linear/Stripe/Raycast minimal realism:

- Hairline borders: `1px solid rgba(255, 255, 255, 0.08)` on panel/chrome edges that still use thicker or neon borders
- Matte slate surfaces: `#0b1120`, `#111827`, `#131b2e` (no neon glows)
- Ensure `font-variant-numeric: tabular-nums` on counters, telemetry chips, Wilson scores, pacing ratios, analytics/tracker numeric cells that lack it
- Keep responsive grid/layout intact; no new card clutter or decorative gradients as the main idea

## Rules

- Do not edit TypeScript, Go, or Python in this run
- Do not run E2E, claim 382/382, or deploy
- If already satisfied, cite selectors/line evidence and make **zero edits**

## Completion criterion

Every numeric counter/telemetry class in `style.css` that renders user-facing stats uses tabular nums; borders/surfaces match the contract tokens; changed-file list + summary emitted (or explicit no-op evidence).
