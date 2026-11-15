# Admission / media metrics scrape (Cloud Agent note)

**Date:** 2026-11-15  
**Not** a capacity-doc verdict and **not** a 10k claim.

## Where metrics live

Product ports serve **loopback-only** `GET /metrics` (`observe.WithLoopbackMetrics`; non-loopback → 404; `X-Forwarded-For` ignored for ACL).  
`CF_OBSERVABILITY_ADDR` still exposes `/metrics` plus **pprof**.

| Process | Product `/metrics` | Observability (metrics + pprof) |
| --- | --- | --- |
| `courseforge-api` | `127.0.0.1:18090/metrics` | `127.0.0.1:18190` |
| `courseforge-media` | `127.0.0.1:18094/metrics` | `127.0.0.1:18194` |

Helpers: `perf/scripts/scrape-admission-metrics.sh`, `perf/scripts/scrape-admission-under-load.sh`.

## Idle capacities

| Gauge | API | Media |
| --- | --- | --- |
| `courseforge_admission_capacity{class="critical"}` | 256 | 256 |
| `courseforge_admission_capacity{class="pulse"}` | 512 | 512 |
| `courseforge_admission_capacity{class="browse"}` | 128 | 128 |
| `courseforge_admission_capacity{class="ai"}` | 32 | 32 |
| `courseforge_media_transfers_capacity` | *(external media — absent on API)* | 64 |

## Under sticky auth-playback (VUS_MAX=20, bypass on)

Polled product `/metrics` every ~400 ms during openish sticky20 (fail **0%**, pulses **20136**).

| Gauge | Peak `in_use` / notes |
| --- | --- |
| API admission `pulse` | **9** |
| API admission `browse` / `critical` | **1** / **1** |
| API admission sheds (all classes) | **0** |
| Media `transfers_in_use` / capacity | **10** / 64 |
| Media admission `critical` | **10** |
| Media busy sheds | **0** |
| Media circuit open / trips / rejects | **1** / **4** / **210** (provider path; FORCE unset — shared-host concurrent Ranges, not sticky API itself) |

## Rate-limit fairness (related)

Bypass-off probe on dedicated `:18191` (`CF_TRUST_PROXY=true`, RPS/BURST=10): shared `127.0.0.1` → ~**83.5%** HTTP 429; distinct `X-Forwarded-For` → **0** 429. See §5 of `docs/research/STREAMING_BACKEND_ARCHITECTURE.md`.

## Intentional shed pressure (temporary tiny slots)

`CF_PRIORITY_BROWSE_SLOTS=2` `CF_PRIORITY_AI_SLOTS=1` (critical/pulse kept at 64) on dedicated `:18195`, then restored.

| Signal | Live probe |
| --- | --- |
| Browse 429 / sheds Δ | **14** / **+14** |
| AI 429 / sheds Δ | **19** / **+19** |
| Critical sheds Δ | **0** |
| Critical lease opens during flood | **5/5** |

Unit: `TestPriorityFromEnvShedsOnLoopbackMetrics`. Probe: `perf/admission-shed-live-probe.go`.

## Multi-replica (process-local, not cluster-coordinated)

Two APIs `:18201` / `:18202` with the same tiny slots, flooded in parallel:

| Replica | Browse sheds | AI sheds | Critical sheds | Critical leases |
| --- | --- | --- | --- | --- |
| A `:18201` | 14 | **55** | 0 | 5/5 |
| B `:18202` | 14 | **81** | 0 | 5/5 |

Independent counters prove each process owns its PriorityLimiter — no shared cluster shed state.

## Media MaxTransfers busy shed

Dedicated media `:18210` with `CF_MEDIA_TRANSFER_LIMIT=1` + mediasim DEV/stall; `perf/media-busy-shed-probe.go`:

| Signal | Result |
| --- | --- |
| `transfers_capacity` | **1** |
| Concurrent Range 503 busy | **12** |
| `busy_sheds_total` Δ | **+12** |
| API second lease during shed | **201** |

Env already: `CF_MEDIA_TRANSFER_LIMIT` (1–4096). Defaults restored to capacity **64**.

## Honesty

- Peaks / shed proof are Cloud-feasible evidence — **not** capacity-doc open-model / **not** 10k.
- No Odysee credentials / no durable cgroup pin in this note.
