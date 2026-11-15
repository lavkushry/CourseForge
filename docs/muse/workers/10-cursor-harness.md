# Worker 10 — Cursor harness only (do not run in Muse)

This is **not** a Muse worker prompt.

Verification and deploy checks are owned by Cursor via:

```bash
cd /home/ubuntu/CourseForge
./scripts/muse_verify.sh --all
```

Muse must never:

- Claim 382/382 without Cursor harness output
- Restart `systemctl --user` API/worker units as part of a polish slice
- `docker exec … nginx -s reload` as part of a polish slice

Production restart/reload/health curls are a separate human/Cursor deploy checklist after `--all` is green.
