# Worker 04 — Client-Side User Isolation

Read [`../CONTRACT.md`](../CONTRACT.md) first.

## Scope (touch only)

- `web/src/settings/view.ts`
- `web/src/tutor/view.ts`
- `web/src/career/view.ts`

## Task

Ensure user-specific client state cannot leak across accounts:

- Tutor history key includes `${account.id}`
- Daily study goal key includes `${account.id}`
- Career task checklist key includes user id (+ day if already designed that way)

Device-level prefs (`courseforge_theme`, `courseforge_accent`) may remain global unless you find they store personal data.

## Rules

- Do not change server APIs
- Do not run E2E or deploy
- If already satisfied, cite the key builders with file:line evidence and make **zero edits**

## Completion criterion

Every user-specific `localStorage` read/write in scope is prefixed by account id; zero cross-user leak paths remain; summary (or no-op evidence).
