# Performance harness

Tools for probing API read capacity on a **constrained** local instance. The
10,000 concurrent-learner figure remains a target until measurements land; report
API, media, and AI capacity separately.

## Constrained local box (do not run from the agent)

Simulate a small replica with Docker resource limits (operator-run):

```bash
docker run --cpus=2 --memory=1g --rm -p 8080:8080 \
  -e CF_DATABASE_URL=... \
  -e CF_PUBLIC_ORIGIN=http://127.0.0.1:8080 \
  -e CF_COOKIE_SECURE=false \
  -e CF_MIGRATE=true \
  your-courseforge-api-image
```

Useful env for the Go API on that box:

| Variable | Role |
| --- | --- |
| `CF_DB_MAX_CONNS` / `CF_DB_MIN_CONNS` | pgx pool budget (defaults 16 / 2) |
| `CF_HTTP_*_TIMEOUT` | server read/write/idle timeouts |
| `CF_RATE_LIMIT_*` | per-IP token bucket |
| `CF_TRUST_PROXY` | honor `X-Forwarded-For` when behind nginx (`true` in rewrite compose) |
| `CF_CACHE_TTL` / `REDIS_URL` | hot catalog cache (memory default; Redis optional) |
| `PPROF_ADDR` | loopback-only pprof (e.g. `127.0.0.1:6060`) |

## k6 read load

Requires [k6](https://grafana.com/docs/k6/).

```bash
# Smoke at 100 VUs
MAX_VUS=100 BASE_URL=http://127.0.0.1:8080 k6 run perf/k6/read-load.js

# Full ramp (default MAX_VUS=10000). Pass a known published course for detail hits:
MAX_VUS=10000 COURSE_ID=course-a BASE_URL=http://127.0.0.1:8080 k6 run perf/k6/read-load.js
```

Thresholds: `http_req_failed < 1%` and p95 `< 500ms` on health/ready, public
catalog list, and course detail. Hitting those gates on a 2 vCPU / 1 GiB box is
necessary but not sufficient evidence for 10k authenticated media sessions.

See also `docs/perf/indexes.md` and `docs/perf/sessions.md`.
