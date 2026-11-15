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
| `CF_PRIORITY_*_SLOTS` | PlayAPI-style admission budgets (`CRITICAL`/`PULSE`/`BROWSE`/`AI`); unset → defaults 256/512/128/32; **per-process** (not cluster-coordinated) |
| `CF_MEDIA_TRANSFER_LIMIT` | media-plane MaxTransfers (1–4096; default 64); busy → 503 + `courseforge_media_busy_sheds_total` |
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

## Authenticated playback (API plane)

Scripts under `perf/k6/auth-playback-*.js` seed synthetic accounts against an
open-registration rewrite API, then open/pulse playback leases. **Not** a
capacity-doc open-model campaign and **not** a 10k claim.

| Script | Role |
| --- | --- |
| `auth-playback-smoke.js` | Constant-VU smoke; shared setup/`default` for siblings |
| `auth-playback-ramp.js` | Small stepped ramp (≤5 VUs) |
| `auth-playback-openish.js` | Cloud-feasible stepped peak (default 5→10→20→40) |

Lease model (default **sticky**): one lease per account/VU; first open uses
`take_over`; pulses reuse the lease; release only on 409/403 reclaim or when
`LEASE_MODE=churn`. This avoids multi-open-per-account storms under ramping VUs.

Loadtest bypass: set `CF_LOADTEST_BYPASS_TOKEN` on the API and pass the same
value as `LOADTEST_TOKEN` so k6 sends `X-CourseForge-Loadtest`. Without bypass,
all VUs share `RemoteAddr` `127.0.0.1` and hit the **per-IP** token bucket (HTTP
429 `rate_limited`) — that is an artifact of loopback loadgen, not lease 409.

```bash
export COURSE_ID='…' LESSON_ID='…'
export BASE_URL=http://127.0.0.1:18090
export LOADTEST_TOKEN=local-smoke-only   # matches CF_LOADTEST_BYPASS_TOKEN
export ACCOUNTS=40 VUS_MAX=40 LEASE_MODE=sticky
k6 run perf/k6/auth-playback-openish.js
```

## Rate-limit fairness (bypass off)

`perf/k6/rate-limit-fairness.js` contrasts shared-IP vs distinct `X-Forwarded-For`
against a dedicated API with `CF_TRUST_PROXY=true`, tight `CF_RATE_LIMIT_*`, and
**no** `CF_LOADTEST_BYPASS_TOKEN`. Public catalog only; proves IP-bucket fairness,
not learner capacity.

## Observability scrape

Product listeners expose **loopback-only** `GET /metrics` (non-loopback → 404).
`CF_OBSERVABILITY_ADDR` still serves metrics + pprof (Cloud Agent: API `:18190`,
media `:18194`). Prefer product `:18090`/`:18094` for scrapes:

```bash
perf/scripts/scrape-admission-metrics.sh
DURATION_S=90 INTERVAL_MS=400 perf/scripts/scrape-admission-under-load.sh /tmp/cf-admission-under-load.tsv
```

See `docs/perf/admission-metrics-cloud-note.md`.

Shed recording/alert **examples** (not 10k SLOs): `deploy/prometheus/prometheus.yml` + `courseforge-shed-alerts.yml` (scrapes `:18190`/`:18194`).

Mixed-plane occupancy scrape (default **250ms**): `DURATION_S=100 INTERVAL_MS=250 QUIET=1 scripts/scrape-mixed-planes.sh` — report API and media separately; not a blended 10k claim.

See also `docs/perf/indexes.md` and `docs/perf/sessions.md`.
