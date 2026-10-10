# CourseForge academy

The existing library now has verified accounts, enrollment, private learning records and administrator reports. The first administrator owns the learning records created before accounts existed. Existing course and lecture IDs remain unchanged.

## Linux setup

Run from `/home/ubuntu/CourseForge`. Install `requirements.txt`, then back up the database before starting the upgraded API:

```bash
.venv/bin/python scripts/academy_manage.py backup --output data/pre-academy-backup.sqlite3
.venv/bin/python scripts/academy_manage.py migrate
.venv/bin/python scripts/academy_manage.py bootstrap-admin --email admin@courseforge.com
```

The password prompt stays on the server. `--generate` instead writes a random password to `data/initial-admin-password.txt` with mode 0600. Do not commit or share this file. Change the password in Account after signing in, then remove the file. To recover access locally:

```bash
.venv/bin/python scripts/academy_manage.py set-password --email admin@courseforge.com
```

Configure the ignored `.env`: `PUBLIC_BASE_URL` must be the real HTTPS address. Brevo is the selected email provider: set `SMTP_PROVIDER=brevo`, `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`, a verified `SMTP_FROM`, the SMTP login in `SMTP_USER`, and its SMTP key in `SMTP_PASSWORD`. Use the SMTP key rather than an API key; see [Brevo's SMTP instructions](https://help.brevo.com/hc/en-us/articles/7924908994450-Send-transactional-emails-using-Brevo-SMTP). SMTP uses STARTTLS. Registration, verification and password-reset email require working SMTP. Keep `COOKIE_SECURE=1` on public hosting. For a loopback-only HTTP development server, temporarily use `COOKIE_SECURE=0`.

Students can also join through administrator invitations while email is unavailable. In Students, enter a name and email, optionally grant a course, and create an invitation. Share its private link directly with the intended student after confirming their identity. They choose their own password and activate administrator-approved access. Links expire after 24 hours and are single-use; only their hashes are stored. Administrators can reissue invitations or issue one-hour recovery links. Reissuing invalidates older account links; completing recovery revokes existing sessions. Raw links appear only once in the administrator UI and never in reports or audit logs. Activation approves access through the administrator rather than proving ownership through an email message.

Allow the public hostname through `ALLOWED_HOSTS`, or let `PUBLIC_BASE_URL` add it automatically. Trust forwarded addresses only from your actual proxy through `TRUSTED_PROXY_CIDRS`. Bind the API to loopback and use HTTPS through the existing reverse proxy or Cloudflare tunnel. A temporary tunnel URL can change when the tunnel restarts; email links require updating `PUBLIC_BASE_URL` after any address change.

The service files in `deploy/` use this server's existing user and installation path. Install them into `/etc/systemd/system`, reload systemd, and enable `courseforge` and `courseforge-academy-worker`. Run exactly one academy worker per database; a process lock enforces this. It handles AI generation and Docker grading through the durable task queue. The existing indexing worker remains separate. Do not expose Ollama, Qdrant or the Docker socket publicly.

This installation already uses user services in `/home/ubuntu/.config/systemd/user/`. Keep that setup when upgrading this server; do not also enable duplicate system services. Its installed units omit `User=ubuntu` and use `WantedBy=default.target`. Check or restart them with `systemctl --user status courseforge courseforge-academy-worker` and `systemctl --user restart courseforge courseforge-academy-worker`. The existing Cloudflare tunnel service stays separate.

Open `/#admin`, sign in, and select Administration. Students shows each account's enrollments, reported lesson completions, recent lessons, cumulative lesson activity, assessment scores, lab status, reviews, plans, focus sessions and device/access history. You can suspend accounts, revoke sessions and grant or revoke course access. Courses controls publication and lecture mapping. Imported courses start as drafts; publish them after reviewing their titles, resources and available uploads. Player activity filters session records by student or lecture, course, period and live status, with CSV export. System and audit shows provider synchronization, measured lecture durations, worker heartbeat reports, task counts, email configuration and administrator changes.

## Player and tracking

`ODYSEE_AUTH_TOKEN` and `ODYSEE_CHANNEL_ID` authorize unlisted embedded playback. Rotate any token previously shared in chat. The maintenance task imports the existing manifest and refreshes provider mappings against immutable lecture IDs. A failed refresh preserves existing mappings. Students receive short-lived, single-use frame tokens bound to their account, login session and lesson.

The Odysee iframe supplies playback controls. Its cross-origin embed does not supply verified playback events to CourseForge. The platform records bounded visible lesson activity, timestamped notes/bookmarks and self-reported lesson completion. Notes, bookmarks, transcript references and manually saved resume points reopen the embed with Odysee's `t` parameter. This is timestamp launch, not programmatic control of a running cross-origin player or automatic position capture. [The provider's player source](https://github.com/OdyseeTeam/odysee-frontend/blob/master/ui/component/viewers/videoViewer/index.ts) reads this parameter. Leaving the lesson removes its iframe and closes the activity session; returning creates a fresh authorized frame. A moving account watermark discourages redistribution; it is not DRM. Browser network tools can reveal provider requests and screen recording cannot be prevented by this integration.

Detailed learning actions, lesson sessions and administrator audit logs are retained for 90 days; access logs for 30 days. Cumulative lesson activity, notes, progress and other saved learning records remain until account deletion. Devices/IPs are captured at session opening so recorded sessions survive sign-out. Heartbeats are idempotent, bounded by server elapsed time, and use one activity lease per account to avoid counting parallel tabs twice. Closed sessions cannot earn more time. A live session means a page has a valid activity lease, not that a video is playing. Session report periods filter by opening time in UTC; activity totals are cumulative time within those sessions.

## Validation and recovery

Run `.venv/bin/pytest -q`. Account tests cover verification/reset tokens, CSRF, private-record isolation, enrollment revocation, suspension, task ownership and frame token replay. Browser and capacity checks must use an isolated database, never production test accounts.

Run `.venv/bin/python scripts/academy_capacity.py --users 150 --rounds 2` for an isolated API workload. The script copies the real course database into temporary storage and removes all test accounts afterwards. It does not load-test email delivery, login bursts, CDN streaming or model/Docker throughput. See [the recorded validation](ACADEMY_VALIDATION.md).

Before upgrades, use the backup command above. To roll back, stop both academy services, restore the SQLite backup (remove the corresponding WAL/SHM files while stopped) and restore the matching application revision. Keep the backup and `.env` private. SQLite is suitable for this single-server installation; capacity measurements should be repeated on the destination server after infrastructure changes.
