# Patch-back prompt (Cursor fills → Muse runs)

Use only after `scripts/muse_verify.sh` fails. Replace the placeholders, then:

```bash
cd /home/ubuntu/CourseForge
muse exec \
  --workspace /home/ubuntu/CourseForge \
  --disable-sandbox \
  --model muse-wonder-1.0 \
  --reasoning-effort high \
  --prompt-file docs/muse/PATCH_BACK.md
```

---

Read [`CONTRACT.md`](CONTRACT.md). Fix **only** the failing harness findings below. Do not broaden scope. Do not run full E2E. Emit changed files + a short summary when done.

## Failed gate

- Command: `./scripts/muse_verify.sh __FLAGS__`
- Summary file: `tmp/muse_verify_last.json`
- Exit / status: `__STATUS__`

## Failing tests or errors (paste verbatim)

```
__FAILURE_OUTPUT__
```

## Expected fix slice

- Paths allowed: `__PATHS__`
- Intended change: `__INTENT__`

## Completion criterion

Harness findings above are addressed with minimal edits; unrelated files untouched; report evidence if a failure is environmental (missing DB, wrong Python, Node PATH) rather than a code bug.
