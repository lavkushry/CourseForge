# Muse collaboration contract (CourseForge / ForgeCareer)

Shared invariants for every surgical Muse worker. Cursor owns verification.

## Repository

- Root: `/home/ubuntu/CourseForge`
- Muse must run with `--workspace /home/ubuntu/CourseForge`
- Touch only the paths listed in the active worker prompt
- If invariants are already satisfied, report file:line evidence and make **zero edits**

## Product invariants

1. **Per-user isolation (client):** any user-specific `localStorage` key includes `${account.id}` (or equivalent stable user id). Theme/accent device prefs may stay global.
2. **Per-user isolation (SQL):** every career query that reads or writes user data enforces `WHERE user_id = $1` (or equivalent bound user id).
3. **Vault:** AES-256-GCM decrypt on demand in memory only; never log secrets, cookies, or vault plaintext.
4. **Errors (Go):** use `httpx.Error(w, status, code, message)` / `httpx.JSON` / `httpx.Decode` at the transport edge.
5. **Aesthetic (career UI):** Linear/Stripe minimal — hairline `1px solid rgba(255, 255, 255, 0.08)`, matte slate `#0b1120` / `#111827` / `#131b2e`, no neon clutter; `font-variant-numeric: tabular-nums` on counters, telemetry, Wilson scores, pacing ratios.
6. **Python worker:** session files under `cookies/<user_id>/<platform>_cookies.json`; SimulationAdapter fallback when dry-run / lock contention paths require it.

## Verification ownership

- **Muse does not** run the full E2E suite, claim 382/382, restart systemd, or reload nginx.
- **Cursor runs** `scripts/muse_verify.sh` after each slice and is the source of truth for pass/fail.
- After a failed harness run, Cursor fills `docs/muse/PATCH_BACK.md` and Muse gets that patch prompt only.
