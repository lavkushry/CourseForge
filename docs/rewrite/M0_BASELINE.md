# Legacy API baseline and parity inventory

Measured 2026-10-11 on revision
`5c134026e6db0f4d45f07a31c1073a92095267dd`, with an existing dirty worktree.
The report retains the dirty-path list and current Python source hashes rather
than treating the revision alone as a complete source fingerprint. No production
data or accounts were read or changed. This is a finite API reference measurement;
M0's browser/media/profiling work and subsequent milestone gates remain open.

## Reproduce

```bash
.venv/bin/python scripts/rewrite_inventory.py
.venv/bin/python scripts/rewrite_baseline.py --users 50 --rounds 2 --output docs/rewrite/M0_BASELINE.json
.venv/bin/python -m pytest -q tests/test_academy.py tests/test_registration.py tests/test_native_player.py tests/test_player_sessions.py tests/test_player_delivery.py tests/test_player_recovery.py --junitxml=docs/rewrite/M0_LEGACY_CONTRACT_TESTS.xml
```

The baseline creates a new temporary SQLite database and starts its own single
Uvicorn process on an ephemeral loopback port. It seeds synthetic disabled-login
accounts with distinct cookie sessions; passwords are not verified in this
workload. The temporary directory and process are removed afterward. All Odysee
account environment pairs, including legacy fallback pairs, are explicitly empty;
SMTP is disabled and AI service endpoints point to an unusable loopback port.
The harness calls none of the video/provider, inference, import, mail or lab
execution endpoints. It does not copy the configured database or course library.
The managed sandbox blocks sockets; loopback execution was explicitly approved.

## Fixture and workload

The fixture contains seven published courses with 30 lessons each, one
unpublished course with one lesson, 633 transcript chunks, 50 students/sessions
and 350 enrollments. Each student sees exactly 210 allowed lessons. The closed
workload runs one sequential request chain per learner, without think time:

1. Open a lesson activity session.
2. Twice: list videos, list progress, read learning dashboard, search local
   transcript content and send visible-page activity heartbeat.
3. Save private progress and read it back; create a private note and read it back.
4. Attempt administrator access and an unpublished lesson, both expected 403.

There are 17 requests per learner, 850 total. Semantic assertions check catalog
filtering, saved progress, private note content and activity acknowledgement basis.
These page-activity heartbeats do not claim playback seconds or watched coverage.
SQLite integrity and foreign-key checks run after the workload. The fixture ends
with 50 notes, 50 progress rows and 50 activity sessions. Journal mode is WAL and
the reported default connection synchronous mode is FULL (`2`).

## Observed API results

| Run | Sessions | Requests | Elapsed | Completed RPS | p50 | p95 | p99 | Unexpected failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| First, retained in `M0_BASELINE_RUN1.json` | 50 | 850 | 12.216s | 69.582 | 620.024ms | 1,427.810ms | 2,111.160ms | 0 |
| Final fingerprinted report, `M0_BASELINE.json` | 50 | 850 | 12.252s | 69.378 | 618.624ms | 1,587.024ms | 2,694.524ms | 0 |

Both runs include 100 intentional 403 responses and no lost/readback-mismatched
progress or cross-user note leakage observed by the workload. Both database
integrity checks returned `ok` and foreign-key checks were empty. This is not a
crash-durability test.

Selected final-run route distributions:

| Route | Requests | p95 | p99 |
| --- | ---: | ---: | ---: |
| GET videos | 100 | 888.475ms | 1,165.549ms |
| GET progress | 150 | 899.946ms | 1,172.659ms |
| GET learning dashboard | 100 | 1,341.597ms | 1,354.138ms |
| GET local transcript search | 100 | 1,634.073ms | 1,778.918ms |
| POST visible-page activity heartbeat | 100 | 2,971.519ms | 3,685.385ms |
| POST note | 50 | 810.860ms | 902.251ms |
| PUT explicit progress | 50 | 1,430.886ms | 1,702.195ms |

Machine evidence contains all per-route p50/p95/p99/status counts, resource
observations, source/dependency fingerprints and workload limits. Hardware:
Linux aarch64, four available logical/affinity CPUs, reported physical memory
25,136,467,968 bytes, Python 3.14.4, FastAPI 0.143.0, Starlette 1.7.0,
Uvicorn 0.54.0, httpx 0.28.1 and argon2-cffi 25.1.0. CPU model and cgroup limits
were unavailable. `/proc` samples are observations and may be virtualized; omitted
or zero IO counters must not be interpreted as absence of database IO.

The API and generator share a host with other development processes. Plain
loopback HTTP excludes TLS, geographic RTT and browser rendering. The finite
closed workload does not maintain an open offered-arrival rate and cannot
establish sustainable capacity, a learner maximum, the proposed performance
gates, or the effect of Python versus Go. The observed latency warrants follow-up
SQL/lock/threadpool/request profiling; the language is not identified as the cause.

## Separate verdicts

| Area | Evidence and verdict |
| --- | --- |
| Legacy API synthetic reference | 850 calls per run, zero unexpected failures; scoped baseline captured |
| Media delivery | Not measured: no forwarded bytes, decoding, first-frame/seek or realistic bandwidth |
| Live Odysee | Not measured: no provider calls or provider-approved scale envelope |
| AI/import/lab throughput | Not measured: no model, worker or execution workload |
| 10,000 concurrent learners | Not established; remains the capacity-contract target |

## Existing contract checks

The six-module legacy suite passed **46 tests**, zero failures/errors/skips,
in **13.548 seconds**. `M0_LEGACY_CONTRACT_TESTS.xml` retains JUnit cases;
`M0_LEGACY_CONTRACT_TESTS.json` records the invocation and sanitized summary.
Account/player tests use disposable `academy_env` temporary databases, separate
users and mocked provider responses. Player delivery/recovery execute actual
legacy JavaScript in injected Node harnesses. They do not constitute a real
browser/device or Go compatibility pass.

The suite covers positive/negative account boundaries, verification/recovery,
CSRF/origin, enrollment, private learning state, suspension/session revoke,
native provider restrictions, single ownership/takeover, seek/pause/duplicate
accounting, explicit versus coverage completion, bounded delivery and recovery.
It also checks aggregate retention after session cleanup. Broader product suites
remain separate gates.

## Inventory and migration owners

`scripts/rewrite_inventory.py` uses only AST parsing: it imports no application
modules and touches no application database. It follows the routers included by
`app.main` and records **164 explicit HTTP method/path pairs across 11 modules**.
The static mount and three framework-generated docs/OpenAPI surfaces are listed
separately. Every route has a feature, owner, milestone, required invariants,
candidate legacy tests and a pending public-interface rewrite gate.

| Feature | Explicit method/path pairs | Owner |
| --- | ---: | --- |
| Identity/access | 16 | Backend identity/access |
| Catalog/discovery | 27 | Backend catalog |
| Player | 16 | Backend playback/media and web player |
| Learning records | 40 | Backend learning |
| Planning/habits | 17 | Backend learning |
| AI/import | 6 | Backend jobs and isolated Python adapters |
| Labs | 6 | Backend jobs/labs |
| Administration | 30 | Backend administration |
| Delivery/operations | 6 | Coordinator operations and web delivery |

Candidate tests assign migration responsibility; they are not a claim that every
route/invariant has exact legacy coverage. Browser-only behaviors, stored-record
migrations, artifacts/vectors, source credentials and capacity require additional
gates. All rewrite statuses remain pending in this immutable legacy inventory.
Use the separate milestone evidence to record verified new implementation status.

The inspected current source initializes 64 per-process media slots; the earlier
plan's evidence row mentions 24. This source drift is recorded here without
changing runtime. Neither count is a learner-capacity guarantee.

`M1_CONTRACT.md` specifies the independent acceptance clauses for the Go slice
and planned playback/provider-simulator handoff. Remaining M0 work includes
sanitized full feature fixtures, request/SQL profiles, actual browser baseline,
decodable simulator implementation and route-specific public behavior coverage.
M3–M5 still require full feature parity, data/artifact/vector migration/recovery,
durable worker protocols, sustained 10k testing on named hardware and release
rehearsal. This baseline alone closes none of those later gates.
