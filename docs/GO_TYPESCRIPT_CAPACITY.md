# Capacity contract: 10,000 concurrent learners

Status: proposed acceptance criteria, not measured results. Updated 2026-10-11.
Companion to [the rewrite plan](GO_TYPESCRIPT_REWRITE_PLAN.md).

## Workload definitions

Distinguish registered accounts, authenticated active learners, simultaneous media
transfers, requests per second, and running AI/lab jobs. A virtual user in an HTTP
test is not proof of a decoded video playing in a browser.

The target is 10,000 concurrent active learner sessions. Test both a mixed workload
and an all-viewing workload. These initial profiles must be versioned with the test
fixtures and adjusted if real usage evidence changes them.

| Profile | Offered workload |
| --- | --- |
| Mixed learner load | 8,000 viewing sessions with one pulse/10s; 2,000 browsing learners with one action/5s; 20 new lesson starts/s and 10 note/progress writes/s |
| All-viewing load | 10,000 viewing sessions with one pulse/10s; 20 starts/s, 20 seeks/s and 10 pause/resume transitions/s, including gateway authorization checks |
| Browsing action mix | 50% paginated catalog/detail, 25% search, 25% dashboard/progress; count actual HTTP calls per action |
| Login burst | 10,000 distinct accounts over five minutes (~33.3 sign-ins/s); separate real password verification budget |
| Reconnect storm | 2,000 viewers reconnect over 30s with jitter; enforce the configured upstream admission limits |
| Expensive jobs | Independently configured AI/import/lab submissions and worker capacity; queue instead of running one job per learner |

Use seeded synthetic accounts with distinct sessions and authorization scopes.
Include an initial catalog near the recorded 210-lecture installation, then a growth
fixture of 100,000 accounts, 10,000 lessons and 1 million progress/telemetry records.
Benchmark both hot-course concentration and distributed course access, warm/cold
caches, and allowed/denied requests. Record query plans and cache hit rates.

## Arithmetic that drives the design

The existing browser sends playback and ownership events every 10 seconds plus
visible-page activity every 15 seconds. At 10,000 active visible lessons, this is
approximately `10,000 / 10 + 10,000 / 10 + 10,000 / 15 = 2,667` periodic POST/s,
before transition events and normal browsing. Consolidating into one 10-second
pulse reduces periodic request count to about 1,000/s; database work must still be
measured. Reducing requests does not automatically reduce every write.

Do not store unbounded telemetry: 1,000 pulses/s is 86.4 million pulses/day if
sustained. Keep the latest sequence/lease and interval aggregates transactionally,
retain bounded detailed events under explicit retention, and measure storage/WAL
growth. Never discard credit-bearing state before durable acknowledgement.

At an assumed 3 Mbps average bitrate, 10,000 simultaneous viewers require 30 Gbps
outbound media bandwidth and approximately the same inbound traffic through a
proxy. One hour is approximately 13.5 TB outbound, excluding protocol overhead.
These are illustrative decimal-unit calculations, not measured Odysee bitrates.
API replication alone cannot solve this network requirement.

The existing stream revalidation interval is ten seconds. Long-lived responses can
therefore add about 1,000 authorization checks/s at 10k transfers. New range requests
add checks of their own. Model revocation and lease validation load separately from
browser pulses; no cache may silently widen the access revocation contract.

## Provisional performance gates

Measure application latency at the external HTTPS entrypoint with a same-region
load generator; report network geography. Browser gates use the stated controlled
network/device profile. Provider and model timing are recorded separately.

| Operation | Initial target |
| --- | --- |
| Catalog/detail/dashboard reads | p95 ≤200ms; p99 ≤500ms |
| Pulse/note/progress writes | p95 ≤250ms; p99 ≤750ms; acknowledge only after durable commit |
| Text search | p95 ≤500ms; bounded page size and query duration |
| Password sign-in | p95 ≤1s at specified burst; preserve password-hash strength |
| API errors | Unexpected errors <0.1%; count unexpected 429/503 at target load as failures |
| Media first frame | p95 ≤3s warm source and ≤5s cold source on controlled 20 Mbps/50ms RTT profile with 3 Mbps fixture |
| Seek to frame | p95 ≤1.5s on the same fixture/profile |
| Playback quality | p95 per-session rebuffer ratio <1%; also report aggregate ratio; fatal playback sessions <0.1% of all authorized playback attempts, including startup failures |
| Revocation/takeover | Deny subsequent requests immediately after authoritative revocation; new Go target: cancel active proxy delivery within 10s, independently of arriving upstream chunks; exclude already buffered bytes |
| Durability/isolation | No lost acknowledged writes, double watch credit, cross-user data access, or stale-worker commits |

The media timings above are controlled-test goals. Live Odysee results must report
cold preparation, provider errors and network conditions separately. A simulator pass
is not live-provider capacity evidence. AI generation has no borrowed API latency
promise; report queue delay, first token and completion by model/hardware.

For rebuffer ratio, divide buffering duration after first frame by wall time spent
playing or buffering, excluding intentional pauses and seeks. Use five-minute media
sessions and report seeks separately. Collect at least 100 playback sessions per
browser/network/cache profile across the target-load runs for latency percentiles.
At least 4,000 playback attempts per release profile are needed for a meaningful
initial fatal-rate check; report count and a 95% binomial confidence interval, with
its upper bound below 0.1% for that gate. Sparse live samples receive a sample-only
verdict and cannot establish the fatal-rate target.

The old gateway rechecks while chunks arrive; its nominal ten-second interval is not
a proven hard disconnect bound during a stalled upstream read. The Go target requires
an independent revalidation timer/cancellation path and a stalled-stream test.

No-lost-acknowledged-writes covers process crashes and database restart with durable
storage and commit flushes enabled. Surviving loss of the primary's storage with zero
loss additionally requires a verified synchronous replication/failover design.
Until hosting is selected, catastrophic primary loss has an unresolved recovery point
objective; backup restore alone must not be described as zero-loss failover.

## Bounded concurrency requirements

- Every Go goroutine has an owner, exit path and cancellation. Requests and upstream
  calls have deadlines; limit body size, pagination, event batches and retry queues.
- Explicit database pool budget across *all* API, gateway-authorization and worker
  replicas. For example, 4 API replicas ×24 connections + 16 worker connections +
  8 operational connections =120 total; this is a starting experiment, not sizing
  evidence. Recompute before adding replicas and reserve database maintenance capacity.
- Do not hold a database connection/transaction while streaming bytes or running a
  model. Monitor pool wait, transaction duration, lock wait and query latency.
- Separate limits for password hashing, source resolution, media transfer, AI GPU
  jobs, transcription and labs. Choose each from resource measurements.
- Provider requests use host/global budgets, timeout/backoff and circuit breaking.
  Protect cold-cache starts from a resolution stampede across replicas.
- Player ownership and deduplication use shared transactional state; process-local
  locks, rate limits and session maps cannot enforce fleet-wide invariants.
- Job claiming uses short transactions, lease expiry and fencing tokens. Result
  publication is idempotent; retries do not duplicate artifacts or learning credit.
- During overload, return bounded, documented retry responses and retain durable
  state. Demonstrate recovery after pressure drops; no unbounded memory/queue growth.

[pgxpool](https://pkg.go.dev/github.com/jackc/pgx/v5/pgxpool) provides the shared Go
connection pool. PostgreSQL documents `SKIP LOCKED` as suitable for queue-like
consumers; it is not an appropriate consistency shortcut for learner records.
[PostgreSQL SELECT documentation](https://www.postgresql.org/docs/current/sql-select.html)

## Test sequence and evidence

1. Capture the old application baseline on an isolated fixture; record revision,
   dirty-tree status, hardware, data volume and excluded operations.
2. Measure one Go replica with controlled media. Use both closed learner sessions
   and open arrival-rate tests so slow responses do not silently lower offered load.
   Count dropped iterations and generator saturation as invalid/failing evidence.
   [k6 workload models](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/)
3. Ramp 100 →1,000 →5,000 →10,000 sessions, holding each stage for ten minutes.
   At 10k, sustain 60 minutes, then run a two-hour soak on the selected configuration.
4. Exercise node loss, deploy draining, provider 429/503, slow/truncated streams,
   database pool saturation, PostgreSQL crash/restart, worker death,
   duplicate/reordered telemetry, expirations and reconnect storms. Compare committed
   acknowledgement IDs before/after recovery. If primary failover is in the deployment
   contract, inject it and verify its stated loss bound. Re-run correctness checks
   after each fault.
5. Stress above target in 25% increments until a gate fails or a resource limit is
   reached. Report highest repeatable passing load, the failing constraint and
   headroom. Choose an operating limit below the measured ceiling.
6. Run Chromium/Firefox/WebKit browser cohorts with deterministic decodable media,
   including mobile viewports and lifecycle faults. Test representative real mobile
   devices separately; viewport emulation alone is not device playback proof.
7. Validate a small live Odysee sample, then obtain an agreed provider test envelope
   before large live traffic. Keep high-volume tests on controlled infrastructure
   until that envelope is known. No production learner data or QA accounts required.

Use independent load-generator machines for full capacity tests and monitor their
CPU/network limits. A media simulator that returns tiny synthetic bodies only
validates protocol handling; bandwidth acceptance requires realistic byte rates and
duration. Large simulated streams test delivery; sampled browsers verify decoding.

Every report includes offered/completed RPS, active sessions/transfers, per-route
p50/p95/p99, HTTP/semantic failures, database CPU/IO/pool wait/WAL, Go CPU/RSS/GC/
goroutines, gateway bandwidth/open files, source cache behavior, provider responses,
browser first-frame/seek/rebuffer metrics, job queue ages and cost assumptions.

Record at least three repeatable target-load runs on the same configuration. Compare
language/implementation variants serially on shared hardware, not simultaneously.
Publish separate verdicts: application target, media simulator target, sampled live
playback, and provider-approved live scale. Claim end-to-end 10k only when evidence
covers the complete path and the actual deployment.
