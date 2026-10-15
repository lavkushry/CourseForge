# Sessions and multi-replica auth

## Finding

CourseForge auth is **store-backed**, not process-local.

- Browser holds an HttpOnly `cf_session` cookie whose value is a random bearer token.
- The API stores only `sha256` digests in PostgreSQL table `auth_sessions` (`token_hash` UNIQUE).
- Every authenticated request loads the principal with:

  `auth_sessions` ⨝ `users` filtered by `token_hash`, `revoked_at IS NULL`, `expires_at > now()`, and `NOT suspended`.

- Logout, password change, admin revoke, and account deletion set `revoked_at` in Postgres so **all replicas** observe revocation on the next request (no sticky sessions required for correctness).
- CSRF tokens live on the same session row and are compared for unsafe methods.

## Implications for ~10k concurrent learners

- Multiple API replicas behind nginx/load balancer work without session affinity.
- Session lookup cost is one indexed equality on `token_hash` plus a users PK join; cache layers must not bypass revocation.
- Process-local rate limits (per-IP token bucket) and the in-memory TTL catalog cache are **best-effort per replica**. Set `REDIS_URL` when a shared cache is required across replicas. Fleet-wide abuse controls still need a shared store if that becomes a measured need.
- Playback ownership / leases remain transactional in PostgreSQL (see playback module); do not move them to process memory.
