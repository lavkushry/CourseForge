# Prometheus shed rules (examples)

Wired example config:

| File | Role |
| --- | --- |
| `prometheus.yml` | Scrapes API/media observe `:18190`/`:18194` (+ optional product `:18090`/`:18094`); loads alert rules |
| `courseforge-shed-alerts.yml` | Recording + alert starter for busy/admission sheds |

`courseforge-shed-alerts.yml` covers:

- `courseforge_media_busy_sheds_total` (MaxTransfers busy path)
- `courseforge_admission_sheds_total{class=…}` (priority admission)
- transfer / admission occupancy ratios

These are **not** capacity-doc SLOs and **not** a 10k-learner claim. Thresholds
are illustrative; retune from intentional shed probes
(`CF_MEDIA_TRANSFER_LIMIT`, `CF_PRIORITY_*_SLOTS`) on your replica.

```bash
# From repo root (loopback-only web UI):
prometheus --config.file=deploy/prometheus/prometheus.yml \
  --storage.tsdb.path=/tmp/courseforge-prom-data \
  --web.listen-address=127.0.0.1:19090

promtool check config deploy/prometheus/prometheus.yml
promtool check rules deploy/prometheus/courseforge-shed-alerts.yml
```

Validation (2026-11-15): portable **promtool 2.55.1** (linux/arm64 release tarball;
cached outside the repo, not vendored) reported:

```text
promtool check config deploy/prometheus/prometheus.yml  → SUCCESS
promtool check rules deploy/prometheus/courseforge-shed-alerts.yml → SUCCESS (7 rules)
```

Brief Prometheus **2.55.1** server smoke (`127.0.0.1:19090`, then stopped): loaded **2**
rule groups / **7** rules; `up=1` for `courseforge-api-observe` (`:18190`) and
`courseforge-media-observe` (`:18194`). No 10k alert thresholds.

Keep scrapes on loopback observe/product `/metrics` — not the public listener.

Note: without `CF_MEDIA_FORCE_SIMULATOR=true`, Hybrid prefers Odysee/local over
`CF_MEDIA_SIMULATOR_URL` when accounts exist in root `.env`. Set
`CF_MEDIA_FORCE_SIMULATOR=true` (with `CF_DEV_MODE` + simulator URL) to pin
FixedResolver for mediasim proofs without moving `.env`.

## Durable local sample

`scripts/durable-observe-prom.sh` starts loopback Prometheus with
`--storage.tsdb.retention.time` (default **6h**), scrapes observe planes, writes
TSDB + `durable-observe-verdict.json` under `.ui-evidence/`. Also records a cgroup
honesty probe (`cgroup_fs` writability). This is a **retained sample**, not an
operator multi-host deployment and not a 10k claim.

