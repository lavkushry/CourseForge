# Streaming backend performance and architecture (primary-source research)

**Date:** 2026-11-15  
**Question:** How do YouTube-, Netflix-, and FakeTube-style video streaming backends organize for performance and clear service boundaries—and which patterns transfer to CourseForge’s Go + TypeScript rewrite?  
**Scope:** Research document only; no Go rewrite in this task.  
**Location note:** Saved under `docs/research/` to match the cited-research convention started by `PLAYER_FOCUS_NOTES_ACCESS.md`. Related rewrite plans remain under `docs/` and `docs/rewrite/`.

---

## Executive summary of transferable patterns

Large video platforms converge on a small set of structural ideas that map cleanly onto CourseForge’s existing rewrite direction—without requiring Netflix-scale CDN ownership or inventing unmeasured 10k capacity.

1. **Split control plane from media plane.** Authorization, manifests/leases, progress, and catalog live on application services; byte delivery lives on a separate path that does not hold learner identity stores. Netflix Open Connect OCAs only serve HTTP media and report health/file availability; member data stays in AWS control services ([Open Connect Overview](https://openconnect.netflix.com/Open-Connect-Overview.pdf)). CourseForge already proposes `cmd/api` vs media gateway replicas in `docs/GO_TYPESCRIPT_REWRITE_PLAN.md`.

2. **Authorize, then steer (or proxy) media.** Netflix checks membership/licensing in Playback Apps, then steers the client to ranked OCAs ([Open Connect Overview](https://openconnect.netflix.com/Open-Connect-Overview.pdf); [cache-miss classification](https://netflixtechblog.com/driving-content-delivery-efficiency-through-classifying-cache-misses-ffcf08026b6c)). CourseForge’s default remains an authenticated gateway with lease revalidation (`GO_TYPESCRIPT_REWRITE_PLAN.md`, `backend/internal/media`, `backend/internal/playback`).

3. **Keep discovery/catalog APIs separate from playback APIs.** Netflix’s API explicitly separates discovery vs playback orchestration and debated pass-through vs split APIs so each team owns release and ops ([API re-architecture](https://netflixtechblog.com/engineering-trade-offs-and-the-netflix-api-re-architecture-64f122b277dd)). CourseForge’s module table (catalog / access / learning / playback / media / jobs) already encodes this.

4. **Use adaptive HTTP streaming (HLS/DASH) so clients adapt bitrate; cache segments aggressively, playlists briefly.** RFC 8216 and DASH ISO/IEC 23009-1 define client-driven adaptation over ordinary HTTP caching ([RFC 8216](https://www.rfc-editor.org/rfc/rfc8216); [ISO/IEC 23009-1](https://www.iso.org/standard/23009-1)). CourseForge’s `docs/MEDIA_DELIVERY.md` already mirrors long-lived immutable segments and short playlist TTL for local HLS.

5. **Prioritize critical playback work under overload; queue the rest.** Netflix PlayAPI guarantees capacity for user-initiated play over prefetch via partitioned concurrency limits ([prioritized load shedding](https://netflixtechblog.com/enhancing-netflix-reliability-with-service-level-prioritized-load-shedding-e735e6ce8f7d)). CourseForge should shed/queue catalog prefetch, AI jobs, and non-credit telemetry before lease acquisition or media admission.

6. **Bound progress/telemetry storage; do not retain every pulse forever.** Netflix compressed viewing history behind EVCache and rolled up time-series ([viewing history Part I](https://netflixtechblog.com/scaling-time-series-data-storage-part-i-ec2b6d44ba39)). CourseForge’s capacity contract already forbids unbounded pulse retention at ~1k pulses/s.

7. **Treat encode/transcode and AI as separate capacity domains with durable job leases.** Netflix rebuilt encoding as inspect → analyze → ladder → encode → validate microservices with chunk parallelism ([video processing pipeline](https://netflixtechblog.com/rebuilding-netflix-video-processing-pipeline-with-microservices-4e5e6310e359)); YouTube invested in specialized transcoder hardware for codec efficiency ([YouTube VCU](https://blog.youtube/inside-youtube/new-era-video-infrastructure/)); FakeTube/AWS use event-driven object store → MediaConvert → CDN packaging ([FakeTube #1](https://faketube.dev/blog/build-youtube-clone-with-aws); [MediaConvert ABR outputs](https://docs.aws.amazon.com/mediaconvert/latest/ug/outputs-file-ABR.html)). CourseForge already separates `jobs` leases from HTTP learner counts (`docs/rewrite/JOBS_CONTRACT.md`, `backend/internal/jobs`).

8. **Measure API, media, and AI separately—and correlate with a playback-session identifier.** Netflix groups traces by playback session ID for multi-system diagnosis ([observability lessons](https://netflixtechblog.com/lessons-from-building-observability-tools-at-netflix-7cfafed6ab17)). CourseForge’s capacity contract and `AGENTS.md` already require separate API / media / AI verdicts and forbid claiming 10k without scoped evidence.

**Does not transfer as-is:** building a proprietary ISP-embedded CDN (Open Connect), custom ASICs (YouTube VCU), learned DRAM cache eviction at YouTube CDN scale (HALP), public CDN caching of private Odysee bytes, Kafka/EVCache as default dependencies, or treating FakeTube’s AWS tutorial architecture as capacity proof.

---

## 1. CourseForge context (in-repo primary)

### 1.1 Rewrite plan architecture

`docs/GO_TYPESCRIPT_REWRITE_PLAN.md` states:

- Go owns the application backend; TypeScript owns the browser player; **Odysee remains the video provider**.
- **10,000 concurrent learners is a target**, not measured capacity or a promise of 10,000 simultaneous AI jobs.
- Proposed layout: HTTPS entry → **API replicas** and **media gateway replicas** → PostgreSQL; jobs coordinator → isolated Python AI / labs; media validates leases then range-proxies Odysee (or serves local HLS).
- Module ownership already separates **catalog**, **access**, **learning**, **playback**, **media**, **jobs**, **identity**, **administration**.
- Caching guidance: versioned public catalog caching first; shared cache only with an invalidation contract. No Kafka/Redis merely because the target is 10k.
- Media: do not assume Odysee supplies HLS; preserve HEAD/Range/206/416, bounded concurrency, source-resolution dedupe; credentials stay server-side.

### 1.2 Capacity contract

`docs/GO_TYPESCRIPT_CAPACITY.md` requires:

- Separate definitions for registered accounts, active sessions, simultaneous **media transfers**, RPS, and running AI/lab jobs.
- Pulse consolidation to ~1,000/s at 10k viewers; **bounded** durable telemetry (latest sequence/lease + aggregates).
- Illustrative media math: 10k × 3 Mbps ≈ 30 Gbps outbound—**API replicas cannot solve media bandwidth**.
- Gates for catalog reads, pulse writes, media first-frame/seek/rebuffer, revocation within 10s, isolation/durability.
- Bounded concurrency: pool budgets, no DB connection held while streaming or calling models, provider circuit breaking, transactional player ownership, job fencing with `SKIP LOCKED` for queues only.
- Publish **separate verdicts**: application, media simulator, sampled live playback, provider-approved live scale.

### 1.3 Current Go packages (high-level map)

| Area | Packages / entrypoints | Role today |
| --- | --- | --- |
| HTTP product API | `backend/cmd/api`, `internal/api` | Catalog, courses, lessons, progress, streaming home, notes, search |
| Playback ownership | `internal/playback` | Leases, pulses, credit/coverage accounting, preferences, HLS path helpers |
| Media delivery | `cmd/media`, `internal/media` (+ `hls/`), Odysee adapter | Authorized gateway, range proxy, local HLS serve, source resolve/retry |
| Encode worker | `cmd/media/worker` | Ladder encode → fMP4/TS segments + progressive fallback (`docs/MEDIA_DELIVERY.md`) |
| Jobs / AI / labs | `cmd/worker`, `cmd/splitworker`, `internal/jobs`, `internal/ai`, `internal/labs` | Durable queue, leases/fences, outbox, resource pools |
| Identity / access | `internal/identity`, `internal/access` | Sessions, enrollment predicates |
| Learning / planning | `internal/learning`, `internal/planning`, `internal/activity` | Notes, progress, habits (learner isolation) |
| Observability | `internal/observe` | Metrics/tracing surface for rewrite |
| Cache / rate limit | `internal/cache`, `internal/ratelimit` | Catalog and admission helpers |

Local media policy in `docs/MEDIA_DELIVERY.md`: immutable long-TTL HLS segments, short-TTL playlists, `private, no-store` progressive token URLs, Range support, no gzip of media segments.

### 1.4 Jobs contract alignment

`docs/rewrite/JOBS_CONTRACT.md`: learner-bound submission, idempotency keys, global/per-learner queue limits, lease + fence, no DB hold during model/sandbox IO, outbox for external side effects, isolation of private results—already matches industry job-lease patterns without importing Netflix’s full microservice encode fleet.

---

## 2. Per-platform / per-source findings

### 2.1 Netflix — Open Connect, playback control plane, API boundaries

#### Content delivery / CDN

| Claim | Source | Supports |
| --- | --- | --- |
| Open Connect is Netflix’s purpose-built CDN delivering Netflix video via HTTP/HTTPS by placing content near viewers; OCAs store playable bits only | [Open Connect Overview (PDF)](https://openconnect.netflix.com/Open-Connect-Overview.pdf) | Media plane ≠ member-data plane |
| OCAs report health, BGP routes, and on-disk files to AWS control plane; they do **not** store viewing history, DRM info, or member data | Same | Gateway/proxy must not become the system of record for learner state |
| Playback flow: OCA reports → client play request to AWS → auth/licensing + file selection → steering service ranks OCAs → client fetches from OCAs | Same; also [Driving content delivery efficiency…](https://netflixtechblog.com/driving-content-delivery-efficiency-through-classifying-cache-misses-ffcf08026b6c) | Authorize then steer/proxy |
| Proactive fill during off-peak; popularity forecasting for edge placement; “cache miss” defined as bytes not served from most-proximal site | Overview PDF; [cache miss post](https://netflixtechblog.com/driving-content-delivery-efficiency-through-classifying-cache-misses-ffcf08026b6c); [data science for delivery](https://netflixtechblog.com/how-data-science-helps-power-worldwide-delivery-of-netflix-content-bac55800f9a7) | Preposition hot lessons when CourseForge owns bytes; with Odysee, measure provider locality instead of inventing ISP appliances |

**CourseForge fit:** Keep Odysee (or local HLS) as the byte origin; invest in **control-plane** lease/auth quality and **admission/bandwidth** measurement. Do **not** attempt Open Connect–style ISP embedding. A provider-approved direct URL path is allowed only if revocation/access contracts still hold (`GO_TYPESCRIPT_REWRITE_PLAN.md`).

#### API layering / playback vs discovery

| Claim | Source | Supports |
| --- | --- | --- |
| Netflix API is an orchestration front door composing microservices into coarse APIs in three categories: non-member, discovery, playback | [Engineering trade-offs and the Netflix API re-architecture](https://netflixtechblog.com/engineering-trade-offs-and-the-netflix-api-re-architecture-64f122b277dd) | Keep catalog/discovery routes separate from playback lease/pulse routes |
| Playback requests mostly map only to playback backends; discovery has a larger fan-out | Same | Avoid coupling browse/search latency to lease DB paths |
| They considered pass-through orchestration vs **two APIs** so playback and discovery teams own release/ops independently | Same | Separate deployables (`cmd/api` vs `cmd/media` / workers) without microservicing every feature |

#### Prioritized concurrency under load

| Claim | Source | Supports |
| --- | --- | --- |
| PlayAPI handles manifest/license requests; user-initiated play is critical, prefetch is not | [Service-level prioritized load shedding](https://netflixtechblog.com/enhancing-netflix-reliability-with-service-level-prioritized-load-shedding-e735e6ce8f7d) | Priority classes for CourseForge: lease/start > pulse > catalog browse > AI submit |
| Partitioned concurrency limiter: user-initiated guaranteed capacity; prefetch uses excess only; reject cheaply via headers without parsing bodies | Same; [Netflix/concurrency-limits](https://github.com/Netflix/concurrency-limits) | Implement admission in Go middleware/media gateway before expensive resolve |

#### Identity propagation / isolation

| Claim | Source | Supports |
| --- | --- | --- |
| Zuul terminates external tokens; internal “Passport” carries user+device identity per request (HMAC, protobuf), scoped to request lifetime | [Edge authentication and token-agnostic identity propagation](https://netflixtechblog.com/edge-authentication-and-token-agnostic-identity-propagation-514e47e0b602) | Propagate authenticated principal into playback/media; never expose Odysee credentials or long-lived provider tokens to the browser |

#### Progress / caching of viewing data

| Claim | Source | Supports |
| --- | --- | --- |
| Viewing history writes to Cassandra; EVCache holds compressed per-customer blobs; large histories are chunked | [Scaling time-series data storage Part I](https://netflixtechblog.com/scaling-time-series-data-storage-part-i-ec2b6d44ba39) | Cache **aggregates**, not every pulse; chunk large coverage if needed |
| Later architecture splits recent/past/historical clusters and parallel reads with high cache hit rates | [Part II](https://netflixtechblog.com/scaling-time-series-data-storage-part-ii-d67939655586) | Hot progress tables + retention tiers match capacity doc |

#### Encode / package pipeline

| Claim | Source | Supports |
| --- | --- | --- |
| Encoding rebuilt as microservices: inspection, complexity analysis, ladder generation, encoding, validation; chunk-parallel encode | [Rebuilding Netflix video processing pipeline…](https://netflixtechblog.com/rebuilding-netflix-video-processing-pipeline-with-microservices-4e5e6310e359) | Keep media worker as its own pool; queue encodes separately from API |
| Per-title ladders optimize bitrate/resolution by content complexity | [Per-title encode optimization](https://netflixtechblog.com/per-title-encode-optimization-7e99442b62a2) | Optional later for owned encodes; fixed 240p–1080p ladder in `MEDIA_DELIVERY.md` is a valid starting contract |
| Packaging adds system layer after encode for client consumption | [Cloud packaging in the terabyte era](https://netflixtechblog.com/netflix-cloud-packaging-in-the-terabyte-era-d6869b4b84ae) | HLS packaging step belongs with media worker, not API handlers |

#### Observability

| Claim | Source | Supports |
| --- | --- | --- |
| Group distributed traces by **playback session identifier**; analyzers answer session-scoped QoE questions | [Lessons from building observability tools at Netflix](https://netflixtechblog.com/lessons-from-building-observability-tools-at-netflix-7cfafed6ab17) | Bind request IDs + lease/session IDs across API, gateway, and player telemetry |

---

### 2.2 YouTube / Google — upload scale, adaptive streaming, CDN efficiency

#### Transcode infrastructure

| Claim | Source | Supports |
| --- | --- | --- |
| Uploads arrive in one format; infrastructure must transcode for many devices/resolutions; custom Video Coding Units (VCUs) improved compute efficiency ~20–33× vs prior CPU software stack | [Reimagining video infrastructure to empower YouTube](https://blog.youtube/inside-youtube/new-era-video-infrastructure/) (YouTube Blog, 2021) | Encode is a separate, capital-intensive capacity domain—never counted as “concurrent learners” |
| Codec shifts (e.g. VP9/AV1) raise encode cost for bandwidth savings | Same | Prefer efficient delivery codecs when CourseForge owns encodes; measure worker GPU/CPU separately |

#### Adaptive / chunked delivery

| Claim | Source | Supports |
| --- | --- | --- |
| YouTube moved to chunked/range requests and adaptive streaming so clients request small segments and adapt under congestion (reduces over-send; avoids buffer spinner) | [Google I/O 2013 – Adaptive Streaming for You and YouTube](https://www.youtube.com/watch?v=UklDSMG9ffU) (first-party Google/YouTube talk) | Prefer HLS/DASH or Range progressive over whole-file download; align with player ABR only when real renditions exist (rewrite plan honesty rule) |
| YouTube adjusts quality based on how smoothly playback is progressing | [Information sharing for more efficient network utilization…](https://research.google/blog/information-sharing-for-more-efficient-network-utilization-and-management/) | Client adaptation + server-reported network conditions; CourseForge reports rebuffer gates from capacity contract |

#### CDN / cache efficiency

| Claim | Source | Supports |
| --- | --- | --- |
| YouTube CDN DRAM cache uses HALP (heuristic + learned preference eviction); production gains ~12% memory egress/ingress, ~6% memory hit rate; lower latency vs disk | [Preference learning… cache eviction](https://research.google/blog/preference-learning-with-automated-feedback-for-cache-eviction/); [HALP paper page](https://research.google/pubs/halp-heuristic-aided-learned-preference-eviction-policy-for-youtube-content-delivery-network/) | When CourseForge serves owned HLS, prioritize segment cache hit rate; ML eviction is optional/out-of-scope until a CDN layer exists |
| Google peers/caches near access providers to reduce latency and ISP cost | [Information sharing…](https://research.google/blog/information-sharing-for-more-efficient-network-utilization-and-management/) | Edge placement is a hosting/CDN concern, not a Go package concern |

#### Load balancing (API-side lesson)

| Claim | Source | Supports |
| --- | --- | --- |
| Prequal load balancer (deployed on YouTube) selects backends by estimated latency and requests-in-flight rather than raw CPU load; reduced tail latency | [Load is not what you should balance: Introducing Prequal](https://research.google/pubs/load-is-not-what-you-should-balance-introducing-prequal/) | When scaling API/media replicas, prefer RIF/latency-aware LB over naive round-robin on CPU alone |

**Primary-source gap (YouTube):** Google publishes comparatively little first-party detail on **session ownership / multi-tab takeover** semantics for YouTube watch sessions. CourseForge should continue to treat its own playback lease contract as authoritative for learner isolation.

---

### 2.3 Adaptive streaming specs (HLS / DASH)

| Claim | Source | Supports |
| --- | --- | --- |
| HLS transfers media as playlists + segments over HTTP; clients adapt bitrate to network conditions; designed for large-scale HTTP caching | [RFC 8216: HTTP Live Streaming](https://www.rfc-editor.org/rfc/rfc8216) | Segmented delivery + CDN-friendly caching |
| HLS 2nd Edition draft continues the same model (multivariant + media playlists, version 13 described in Apple’s draft) | [Apple HLS draft PDF](https://developer.apple.com/streaming/HLS-draft-pantos.pdf); [Apple Streaming hub](https://developer.apple.com/streaming/) | Author against current HLS when extending `media/worker` |
| Authoring rules: continuous media across segments, IDR starts for video segments, accurate `EXTINF`, aligned A/V where possible, I-frame playlists for scrubbing | [HLS authoring specification for Apple devices](https://developer.apple.com/streaming/hls-authoring-specification-for-apple-devices.html) | Quality gates for CourseForge’s fixed 5s fMP4 ladder |
| MPEG-DASH: client-controlled adaptive streaming; MPD + segments; servers need not be DASH-aware beyond HTTP | [ISO/IEC 23009-1](https://www.iso.org/standard/23009-1); 5th edition freely available note via [DASH-IF](https://dashif.org/news/5th-edition/) | DASH is an alternative packaging path if needed |
| DASH-IF IOP V5 maps DASH to CMAF and splits on-demand vs live guidance | [DASH-IF IOP V5](https://dashif.org/guidelines/iop-v5/) | Interop checklist if DASH is added later |

**CourseForge fit:** Local HLS in `MEDIA_DELIVERY.md` already matches the caching split (immutable segments / short playlist TTL). Progressive MP4 with Range remains valid when Odysee does not offer ABR; the rewrite plan forbids fake quality menus without real renditions.

---

### 2.4 FakeTube-style open “YouTube clone” backends

FakeTube is a first-party tutorial/product series by Jacek Kościesza ([faketube.dev](https://faketube.dev/blog/build-youtube-clone-with-aws), GitHub `JacekKosciesza/FakeTube`). It is **not** a hyperscale production postmortem. Treat it as a reference architecture for VOD upload pipelines on AWS, not as capacity evidence.

| Claim | Source | Supports |
| --- | --- | --- |
| Architecture: upload to object store → event → Elemental MediaConvert → ABR packages + thumbnails → CloudFront delivery; app notified of progress | [Build YouTube Clone with AWS – FakeTube #1](https://faketube.dev/blog/build-youtube-clone-with-aws) | Event-driven encode pipeline separate from catalog API |
| Catalog/home API: REST (API Gateway + Lambda + Aurora PostgreSQL) and later GraphQL (AppSync + DynamoDB) with explicit access patterns (list by `publishedAt`, get by `videoId`/`channelId`) | [FakeTube #5](https://dev.to/jacekkosciesza/videos-rest-api-with-api-gateway-lambda-aurora-serverless-faketube-5-1102); [FakeTube #6](https://dev.to/jacekkosciesza/videos-graphql-api-with-appsync-lambda-dynamodb-faketube-6-2jcb) | Design catalog queries around declared access patterns; pagination tokens |
| AWS MediaConvert formalizes ABR output groups (HLS, DASH ISO, CMAF, Smooth) producing manifests + segments; File group for progressive | [MediaConvert outputs / ABR](https://docs.aws.amazon.com/mediaconvert/latest/ug/outputs-file-ABR.html); [choosing ABR groups](https://docs.aws.amazon.com/mediaconvert/latest/ug/choosing-your-streaming-output-groups.html) | Same packaging taxonomy as CourseForge’s HLS + progressive fallback |

**Gaps:** No FakeTube primary source for multi-learner lease ownership, enrollment isolation, pulse/credit accounting, or measured multi-thousand concurrent streams. Do not import serverless fan-out as the Go rewrite’s default.

---

## 3. Explicit mapping: applies vs does not apply to CourseForge

| Pattern | Applies? | Why |
| --- | --- | --- |
| Separate API vs media deployables | **Yes** | Matches rewrite mermaid diagram and Netflix control/data plane split; packages already exist |
| Authorize before byte delivery; revalidate leases | **Yes** | Netflix Playback Apps + CourseForge media `Authority` / playback leases |
| Catalog/discovery ≠ playback ≠ jobs capacity | **Yes** | Netflix API categories; capacity + jobs contracts |
| HLS/DASH segmented caching semantics | **Yes for owned/local HLS** | Specs + `MEDIA_DELIVERY.md`; **partial for Odysee** until provider ABR exists |
| Prioritized admission (play > prefetch > AI) | **Yes** | PlayAPI QoS; maps to Go rate limits / gateway busy responses |
| Bounded progress retention + session-scoped observability | **Yes** | Netflix viewing-history + observability; capacity arithmetic |
| Durable job leases / fences / outbox for encode & AI | **Yes** | Netflix encode services conceptually; FakeTube event pipeline; already in `jobs` |
| Fixed encode ladder then optional per-title optimization | **Yes, later** | Start with `media/worker` ladder; per-title/VMAF is optional |
| Build Open Connect / ISP appliances | **No** | Odysee owns external CDN relationship; unknown concurrency envelope |
| YouTube VCU / custom silicon | **No** | Wrong scale and ownership; use ordinary workers / future GPU pool |
| HALP / learned CDN DRAM eviction | **No (now)** | Requires owning a CDN cache tier at YouTube scale |
| Public CDN caching of private lesson bytes | **No** | Would break enrollment revocation; plan forbids public provider URL without access contract |
| Kafka as mandatory telemetry bus | **No** | Rewrite explicitly avoids Kafka/Redis solely for 10k target |
| Claiming 10k learners from architecture diagrams | **No** | Capacity contract: measure or do not claim |
| FakeTube serverless as production Go topology | **No** | Tutorial patterns; CourseForge stays modular monolith + separate entrypoints |

---

## 4. Prioritized rewrite recommendations (organization + performance)

Aligned with M2–M4 in `GO_TYPESCRIPT_REWRITE_PLAN.md` and gates in `GO_TYPESCRIPT_CAPACITY.md`. Order is intentional: correctness and plane separation before exotic caching.

### P0 — Architecture hygiene (do now / keep strict)

1. **Preserve three capacity domains in code and dashboards:** API (`cmd/api`), media (`cmd/media` + Odysee/local HLS), jobs (`cmd/worker` / AI / encode). Never share a single “RPS” SLO across them.
2. **Keep package boundaries:** `playback` owns leases/pulses/credit; `media` owns byte IO and provider adapters; `api` owns catalog/discovery HTTP; `jobs` owns durable work. Resist merging gateway auth into catalog handlers.
3. **Learner isolation as a fleet invariant:** transactional leases (takeover, reclaim only on deliberate action), enrollment predicates on every protected path—process-local maps cannot enforce this (`GO_TYPESCRIPT_CAPACITY.md`).
4. **Propagate principal + playback session/lease IDs** on logs/traces/metrics (Netflix session grouping pattern) without logging Odysee secrets (`AGENTS.md`).

### P1 — Performance that matches primary sources and existing contracts

5. **Admission priority in API and media gateway:** classify `lesson_start` / lease acquire / revoke > pulse > catalog/search prefetch > AI submit. Shed low priority with bounded 429/503 when concurrency limits hit (PlayAPI pattern; reuse `internal/ratelimit`).
6. **Media path:** continue independent revalidation/cancel timer (≤10s revoke target); do not hold `pgx` connections while proxying; bound host/global outbound concurrency; dedupe cold source resolve (rewrite plan + capacity).
7. **HLS when CourseForge owns bytes:** keep immutable segment caching + short playlist TTL; ensure IDR-aligned 5s segments per Apple authoring rules; progressive `no-store` for capability URLs (`MEDIA_DELIVERY.md` + RFC 8216).
8. **Telemetry write path:** acknowledge pulses only after commit; store latest sequence/lease + coverage aggregates; retain detailed events under explicit retention—not 86M rows/day of raw pulses.
9. **Catalog caching:** versioned public/published catalog pages first; invalidate on publication events; do not cache private enrollment-scoped payloads as public.

### P2 — Pipelines and scale work (M3/M4)

10. **Encode/AI workers:** claim with fence + `SKIP LOCKED`; separate resource pools for transcode vs tutor vs labs (`JOBS_CONTRACT.md`). FakeTube’s upload→queue→ABR→notify shape is the right *event* shape, not a mandate for AWS MediaConvert.
11. **Optional provider-direct delivery** only after proving authz + revocation; otherwise keep authenticated gateway.
12. **Replica LB / pool budgets:** size `pgxpool` across API + gateway-auth + workers explicitly; prefer latency/RIF-aware load balancing when adding replicas (Prequal lesson at high level).
13. **Per-title encode / ABR expansion:** only after owned-media QoE evidence; do not fake Netflix ladders on single-rendition Odysee progressive streams.

---

## 5. Suggested verification gates (no unmeasured capacity claims)

Use these as **pass/fail evidence collectors**. Passing a gate does not imply 10k learners unless the run used the capacity contract’s workload and hardware profile.

### Organization / correctness

| Gate | Commands / evidence (illustrative) | Pass means |
| --- | --- | --- |
| Module isolation | `cd backend && /usr/local/bin/go test ./internal/playback/... ./internal/media/... ./internal/jobs/... ./internal/access/...` with `CF_TEST_DATABASE_URL` set | Lease, credit, claim/fence, cross-user denial tests green |
| Race on concurrent ownership | `go test -race ./internal/playback/... ./internal/jobs/...` (bounded `-p` if pool pressure) | No data races; takeover/dedupe holds |
| Jobs contract | Tests already described in `JOBS_CONTRACT.md` (two queue clients, stale fence, outbox) | Stale workers cannot publish; idempotent submit |

### API vs media vs AI (separate reports)

| Gate | Approach | Pass means |
| --- | --- | --- |
| API latency | k6/open model against catalog + pulse mix on one Go replica; record p95/p99 vs capacity table | Application-only verdict; media/AI excluded |
| Media protocol | `cmd/mediasim` / gateway tests: Range, 206/416, revoke within 10s, busy admission | Simulator verdict only |
| Browser playback | Playwright on deterministic media: first-frame, seek, rebuffer ratio definition from capacity doc | Sampled browser verdict |
| Live Odysee | **n=1** + one-lease n=64 + **multi-learner through 64×1 sample** (Hybrid, FORCE off); stop on 429/503 without storms | Sample-only; **≠** CDN scale / **≠** 10k |
| AI/jobs | Queue age, lease reclaim, per-resource concurrency under synthetic submissions | Job throughput ≠ learner concurrency |

### Capacity progression (from capacity contract)

1. Baseline legacy or current Go on named fixture.  
2. Ramp 100 → 1k → 5k → 10k sessions with 10-minute holds; 60-minute sustain + soak only if earlier stages pass.  
3. Faults: node drain, provider 429/503, pool saturation, duplicate telemetry, worker death.  
4. Publish **four** verdicts: application target, media simulator, sampled live, provider-approved live scale—never a single blended “10k OK.”

Suggested local verification without Docker/Odysee (Cloud Agent constraints in `AGENTS.md`):

```bash
export CF_TEST_DATABASE_URL='postgresql://courseforge:local_rewrite_only@127.0.0.1:5432/courseforge_rewrite?sslmode=disable'
export PATH=/usr/local/bin:$PATH
cd /home/ubuntu/CourseForge/backend
go test ./internal/playback/... ./internal/media/... ./internal/jobs/... ./internal/api/...
go test -race ./internal/playback/... ./internal/jobs/...
```

Web player behavior (Node 22.23.3 first on `PATH`): Vitest/Playwright suites under `web/` as documented in rewrite UI contracts—not capacity proof.

### Capacity campaigns still required (honest checklist)

Architecture and Go package work above do **not** constitute measured capacity. Do not invent pass/fail numbers or claim 10k learners from diagrams. Harnesses live under `perf/` (see `perf/README.md`).

#### Measured on this Cloud Agent host (2026-11-15) — not 10k proof

Host: `aarch64`, **4** CPUs, **~23 GiB** RAM. DB: Docker Postgres **`:15439`** (native `:5432` down). Rewrite API already on loopback **`:18090`**. Fixture: `web/public/spatial/clock.mp4` via `/tmp/mediasim` on **`:18092`**.

| Plane | Command(s) actually run | Numbers | Verdict |
| --- | --- | --- | --- |
| **API** (smoke only) | `BASE_URL=http://127.0.0.1:18090 VUS=20 DURATION=30s k6 run perf/k6/api-smoke.js` against health/live, health/ready, `GET /api/v1/public/courses?limit=20` | 4761 req; fail **0%**; p95 **1.1 ms**; p99 **2.97 ms**; ~158 req/s | **PASS smoke** — public read path only; **not** capacity-doc 10k ramp |
| **API** (auth playback smoke) | Seeded accounts + cookie re-apply; `LOADTEST_TOKEN=local-smoke-only VUS=5 DURATION=20s k6 run perf/k6/auth-playback-smoke.js` on restarted API (`db=6+2 jobs`, `CF_PASSWORD_HASH_WAIT=750ms`) | opens **344** / pulses **1032** / logins **5**; check-fail **0%**; open p95 **9.9 ms**; pulse p95 **9.3 ms** | **PASS smoke** — **not** 10k ramp |
| **API** (auth playback ramp) | `perf/k6/auth-playback-ramp.js` stages 2→4→5 VUs (~85s); same host (best-effort, not pinned 2 vCPU) | opens **921** / pulses **2763**; check-fail **0%**; open p95 **13.0 ms**; pulse p95 **11.5 ms** | **PASS constrained ramp** — local evidence only |
| **Media simulator** | mediasim + `MEDIA_URL=http://127.0.0.1:18092 VUS=10 DURATION=20s k6 run perf/k6/mediasim-smoke.js` | 3311 iters; custom fail **0%**; Range 206 ×2467; synthetic 429 ×518; p95 **~0.98 ms** | **PASS simulator smoke** — protocol/load only |
| **Media simulator** (stall cancel) | `go run ./perf/mediasim-revoke-probe.go -url http://127.0.0.1:18092 -n 20` | 20/20 cancels; p95 **~51 ms** after 50 ms hold; max ≪ 10 s gate | **PASS** client-abort vs `/fault/stall` |
| **Media gateway** (revoke soak) | `go test ./internal/media/ -run TestGatewayRevokeSoakUnderConcurrentTransfers` — 8 concurrent Ranges + lease delete | max_cancel **≈6.0 s**; revalidate 3s | **PASS unit soak** — ≤10s gate; not live Odysee soak |
| **Media gateway** (sibling leases) | `TestGatewayRevokeUnderConcurrentAuthLeases` — Alice+Bob concurrent Ranges; delete Alice lease only | Alice cancel **≈6 s**; Bob stayed live until its own delete | **PASS** lease-scoped revoke under concurrent auth leases |
| **Media + mediasim** (live `:18092`) | `TestGatewayRevokeAgainstLiveMediaSim` — FixedResolver → mediasim `/fault/stall`; 4 concurrent Ranges + lease delete | max_cancel **≈5.8 s** | **PASS** mediasim+gateway revoke (not process `:18094` / not Odysee) |
| **Media live processes** (`:18090`+`:18094`+mediasim) | Rebuilt `courseforge-media` with `CF_MEDIA_FORCE_SIMULATOR` + `/fault/stall`; header Flush after WriteHeader; `go run ./cmd/liverevoke` cookie open → 4 Ranges → lease DELETE | max_cancel **≈5.99 s** (×2 runs); gate ≤10s | **PASS live process revoke** — mediasim upstream only; not Odysee; not 10k |
| **API sustained auth** | `DURATION=90s VUS=5` `perf/k6/auth-playback-smoke.js` on `:18090` | opens **1532**/pulses **4596**; check-fail **0%**; open p95 **14.7 ms**; pulse p95 **15 ms** | **PASS API sustained smoke** — not capacity-doc open-model |
| **API taskset ramp** | `taskset -c 0,1` + `auth-playback-ramp.js` (generator pinned 2 CPUs; API on shared host) | opens **920**/pulses **2760**; check-fail **0%**; open p95 **12.6 ms** | **PASS best-effort** — honesty: not a true `--cpus=2` API pin |
| **Media path** (write idle) | Default `ClientWriteIdle` **30s** (was hardcoded 180s); `CF_MEDIA_CLIENT_WRITE_IDLE` 1s–180s | unit env + gateway tests | **PASS** bounded client write budget |
| **Jobs outbox** | `ClaimOutbox`/`AckOutbox`/`NackOutbox`/`DrainOutboxOnce` + idle `ParkExhaustedOutbox` + `PruneDeliveredOutbox` (7d retention, batch 500) in worker idle loop; stale fence cannot Ack | unit/race tests green | **PASS** durable outbox consumer + retention (no Ollama); external webhook still optional |
| **Playback multi-tab** | Concurrent open without takeover → 1 owner; release frees lease; claim-after-release; displaced claim stays 409 | race tests green | **PASS** ownership edges |
| **Catalog cache** | Admin enrollment → `CatalogInvalidate` hook; gen-stamped Set skip after bump; private list enrolled flag flips | unit tests | **PASS** private catalog invalidation / publish-race Set guard |
| **AI / jobs** | Priority limiter wired in `cmd/api` + `cmd/media`; **split API/jobs pgx pools** (`SplitAPIPools`) in `cmd/api`; jobs saturated → API acquires OK; bcrypt slots stay capped with **bounded** `CF_PASSWORD_HASH_WAIT` | No Ollama | **DB/hash headroom PASS** in unit tests; live AI still blocked |
| **Live Odysee Range (n=1)** | FORCE off (Hybrid); root `.env` Odysee accounts loaded by media `loadEnvFile` (never logged). Lesson with `lesson_providers` claim; open cookie lease + pulse; `GET` `Range: bytes=0-63` via live `:18094` | **206**; `Content-Type: video/mp4`; `Content-Range: bytes 0-63/865773804` (**≈826 MiB** object ≠ mediasim **8523349**); magic `ftyp`; elapsed **≈1.89 s**; media log `source=odysee`. API PID stable | **PASS sample n=1** — not CDN scale / not 10k / credentials stay server-side |
| **Live Odysee revoke (n=2)** | Same Hybrid/FORCE-off path; open lease + pulse; **2** concurrent `Range: bytes=0-4194303` through `:18094`; `DELETE` `playback_leases` for session; measure cancel (URLs/tokens redacted) | **max_cancel ≈906 ms**; concurrent **2**; gate ≤10s **pass=true**; API PID stable | **PASS sample revoke** — not mediasim; not scale proof; not 10k |
| **Live Odysee concurrency envelope (sample)** | FORCE off / Hybrid; one lease + pulse; concurrent Ranges through `:18094` **256 KiB** chunks. Ladder **n=4…64** (at media MaxTransfers). HF observe **100 ms** during n=64. Optional revoke: **n=4/8/16** × **2 MiB** + lease DELETE. Tokens/URLs redacted; stop on 429/503 without storms | **n=4→48:** prior ladder fail **0%**. **n=64:** fail **0%** (64/64 **206**); avg **≈312 ms** / p95 **≈391 ms**; bytes **16 777 216**; total **865 773 804** ≠mediasim; rate_limited **0**; observe peaks **media_xfer=64** / **media_crit=64** (cap). **revoke n=16:** max_cancel **≈185 ms** (≤10s); fail **0%**. API PID stable | **PASS sample envelope through n=64 (=MaxTransfers)** — **not** multi-learner CDN scale / **not** 10k |
| **Live Odysee multi-learner sample** | FORCE off / Hybrid. **Distinct** accounts/leases: **16×2**, **32×2**, then **48×1**, **64×1** (256 KiB) + pulse; stagger seed. Optional revoke: **16×2** delete **8**; **32×1** delete **16** mid-flight. Observe **150 ms** (API vs media gauges separate; **≠** 10k). Tokens/URLs redacted; stop on 429/503 without storms | **16×2:** fail **0%** p95 **≈1612 ms** bytes **8 388 608**. **32×2:** fail **0%** p95 **≈520 ms** bytes **16 777 216**; observe **media_xfer=64**. **48×1:** fail **0%** (48/48 **206**) avg **≈275 ms** / p95 **≈313 ms**; bytes **12 582 912**; observe peak **media_xfer=38** (short Ranges; undersampled vs concurrent fill). **64×1:** fail **0%** (64/64 **206**) avg **≈1781 ms** / p95 **≈1804 ms**; bytes **16 777 216**; observe **media_xfer=64**/crit **64**; rate_limited **0**; ≠mediasim. **revoke 16/32 leases:** max_cancel **≈1.26 s** (≤10s). API PID stable | **PASS multi-learner sample through 64×1** — **≠** CDN account-scale / **≠** 10k |
| **Live Odysee sustained multi-learner hold** | FORCE off / Hybrid. **32** distinct leases (**8** on second course/lesson TrendyTech + **24** primary Agentic); pulse every **8s**; Range every **3s** × **256 KiB** for **75s**. Observe **200 ms**. Stop on 429/503 storms. Tokens/URLs redacted | ranges **799**/799 **206**; fail **0%**; avg **≈610 ms** / p95 **≈889 ms**; bytes **209 453 056** (~200 MiB); rate_limited **0**; ≠mediasim. Observe peaks: **api_pulse=9** / http_active **9**; **media_xfer=32** / crit **32**. Dual-lesson path exercised. API PID stable | **PASS sustained sample** — **≠** CDN account-scale / **≠** 10k |
| **Live Odysee sustained hold 48/64** | FORCE off / Hybrid. Distinct leases + dual-lesson (TrendyTech subset + primary Agentic): **48** (12+36) then **64** (16+48); pulse **8s**; Range **~3–3.5s** × **256 KiB**; hold **75s**. Observe **200 ms**. Stop on storms. Tokens/URLs redacted | **48:** ranges **1200**/1200 **206**; fail **0%**; avg **≈549 ms** / p95 **≈786 ms**; bytes **314 572 800**; observe **media_xfer=48** / api_pulse **40**. **64:** ranges **1408**/1408 **206**; fail **0%**; avg **≈746 ms** / p95 **≈1137 ms**; bytes **369 098 752**; observe **media_xfer=64**/crit **64** / api_pulse **26**; rate_limited **0**; ≠mediasim. API PID stable | **PASS sustained through 64 leases** — **≠** CDN account-scale / **≠** 10k |
| **Browser QoE cohort** (Chromium) | `web/scripts/qoe-browser-cohort.mjs` N=5 vs Vite `:5173` → API `:18090` → media `:18094` with `CF_MEDIA_FORCE_SIMULATOR` + mediasim `/media.mp4`; auth via API cookie **or** UI `#email`/`#password`/`Continue` (not `Email address`); featured `.hero-play` → click-to-first-frame → ArrowRight seek | **5/5 ok**; playerReadyMs **339/460/492**; firstFrameMs **376/506/534**; seekOk **5/5**; UI-login proof **1/1**; media restored without FORCE after | **PASS sampled QoE** — mediasim path only; not WebKit; not Odysee; not capacity-doc 10k |
| **API pinned-client auth** | `taskset -c 0` curl login smoke 30s against `:18090` (client affinity only; API unpinned) | ok **235** / fail **0** | **PASS honesty note** — not capacity-doc open-model / not true API cgroup pin |
| **API true taskset pin** | `taskset -cp 0` on live `courseforge-api` PID for **25s** auth login smoke; affinity restored to `0-3` | ok **182** / fail **0** | **PASS brief pin** — honesty: CPU affinity only, **not** cgroup `--cpus` / capacity-doc open-model |
| **M3 migrate core slice** | `internal/migrate` JSON snapshot DryRun+Apply (users/courses/lessons/enrollments/progress/notes); Argon2id PHC preserved; auth_sessions never live-imported; cutover revoke; crash/retry all-or-nothing | unit tests green | **PASS foundation** — not full SQLite live import / artifact/vector recovery |
| **M3 migrate v2 + synthetic SQLite** | `m3-core-v2`: bookmarks, materials metadata, player_preferences (autoplay=false preserved), playback_totals (wall playing_seconds→watched_seconds, coverage `[]`), lesson_providers, saved_items; `LoadSnapshotFromSyntheticSQLite` on `testdata/synthetic_core.sqlite3` (asserted, refuses `data/courseforge.sqlite3`) | unit tests green | **PASS extended** — not live production SQLite Apply; no artifact/vector recovery |
| **M3 migrate v3** | `m3-core-v3`: history_cleared, watch_history, lesson_visits, lesson_activity_totals, habit_preferences, learning_preferences, habit_days, course_certificates (legacy), transcript_chunks (text only); account_tokens counted never live; `ApplyFromSyntheticSQLite` e2e; **pgvector skipped** | unit tests green | **PASS** — still no live prod SQLite / vectors / activity session leases |
| **M3 migrate v4** | `m3-core-v4`: jobs (terminal), lesson_quizzes+quiz_versions+attempts, review_cards/sessions, planner/week prefs, daily/weekly plans+items, focus sessions/intervals (running→paused), habit_actions | unit tests green | **PASS** — no review_attempts/schedule invent; no live jobs/leases; no pgvector |
| **M3 migrate v5** | `m3-core-v5`: review_attempts+session links, learning_paths+completions, topic assessments/attempts, practice sessions/attempts, lab sessions/revisions (small text), ai_tutor_logs inventory-only | unit tests green | **PASS** — no Ollama; no Docker labs; tutor logs not inserted (schema missing) |
| **M3 migrate v6** | `036_legacy_archive.sql` + `m3-core-v6`: ai_tutor_logs insert, interview_prep, learning_events, lesson_briefs, placement_tests, reminder_deliveries, syllabi, lab_submissions/grades (no job_id) | unit tests green | **PASS** — SQL inventory for Cloud synthetic Apply essentially closed; cross-store artifacts/vectors still out |
| **M3 migrate v7 + rehearsal** | `037_operational_parity.sql` + `m3-core-v7`: access_events device/IP, service_checks, cover/video path metadata; `TestIsolatedApplyRehearsal` DryRun+Apply into throwaway `cf_test_*` | unit tests green | **PASS rehearsal** — not production cutover; no binary/Qdrant copy |
| **M3 cutover CLI + tiny artifacts** | `cmd/migratecutover` DryRun/Apply into `cf_rehearsal_*` with `--assert-isolated`/`--refuse-live-path`/`--confirm-apply`; `ArtifactMaterialize` copies ≤64KiB cover/source fixtures | unit + CLI tests green | **PASS** — fixture files only; not production cutover; no Qdrant |
| **Media transfer admission** | `Gateway.TransferOccupancy` + `BusySheds`/`NoSourceSheds`/`ProviderFailSheds` + HLS shares MaxTransfers; `X-CourseForge-Media: busy\|no-source`; default `ClientWriteIdle` 30s / `RevalidateEvery` 3s | unit tests (`transfer_metrics_test`, `hls_admission_test`, `write_idle_test`, `status_test`) | **PASS** media-plane slot gauges (no session labels) |
| **Observe plane dashboards** | Product listeners serve **loopback-only** `GET /metrics` via `observe.WithLoopbackMetrics` (XFF ignored for ACL; non-loopback → 404). `CF_OBSERVABILITY_ADDR` still serves `/metrics` + **pprof**. Exports media transfers/sheds, admission `{class}`, circuit gauges | unit + live `:18090`/`:18094` **200** (and observe `:18190`/`:18194`) | **PASS** unified product scrape on loopback; pprof stays observe-only |
| **API openish ramp (sticky lease)** | **429 root cause:** prior 40 VU ~46% check-fail was HTTP **429 `rate_limited`** from the **per-IP** token bucket while every k6 VU shared `RemoteAddr` `127.0.0.1` — **not** lease 409 (accounts already 1:1). Fix: `CF_LOADTEST_BYPASS_TOKEN` → `ratelimit.LoadtestBypassExempt` + k6 `X-CourseForge-Loadtest`; in-repo sticky one-lease/VU + `take_over` + 429 backoff (`perf/k6/auth-playback-smoke.js` / `auth-playback-openish.js`; `ACCOUNTS>=VUS_MAX`) | peak **10**: fail **0%**, open p95 **13.1 ms**, pulse p95 **9.9 ms**, opens **10**/pulses **6084**; peak **20**: fail **0%**, open p95 **13.9 ms**, pulse p95 **12.8 ms**, http p95 **13.2 ms**, opens **20**/pulses **10008**; peak **40**: fail **0%**, open p95 **24.6 ms**, pulse p95 **29.3 ms**, http p95 **30.4 ms**, opens **40**/pulses **20205** | **PASS openish sticky** — **not** capacity-doc open-model / **not** 10k; host-shared, no cgroup pin, bypass on |
| **API open-model-ish without bypass** | Live `:18090` **no** `X-CourseForge-Loadtest` (bypass intentionally unused). Default per-IP bucket **RPS≈120 / burst≈240**, `TrustProxy=false` (shared `127.0.0.1`). (1) sticky pulses VUS=5/25s + VUS=20/20s. (2) concurrent register/enroll/open burst n=80. Contrast prior fairness row (dedicated API RPS=10 → majority 429) | (1) sticky: opens **20/20**; pulses **1286** ok; **429=0** / **409=0** (under default bucket). (2) burst: register **201×2** / **503×78**; open **201×2**; **429=0** — sheds are **admission/503** (password-hash / priority), **not** lease **409**. API PID stable | **PASS honesty sample** — natural shared-IP pressure without bypass; **≠** capacity-doc open-model (no cgroup / multi-host / full mix); **≠** 10k |
| **API no-bypass shed separation (higher load)** | Live `:18090`; **no** `X-CourseForge-Loadtest`. Default per-IP **RPS≈120/burst≈240**, `TrustProxy=false`. (1) concurrent register ladder VUS=60/100 → admission **503**. (2) serial seed N=40 (bypass off) then pulse storm **12s** (3× pulses / 20 ms) | (1) register **503×58**/60 and **503×98**/100; pulse under seed starvation **429=0**/**409=0**. (2) seed opens **40/40**; storm pulses **ok=1681** / **http_429=54053** / **lease_409=0** / **admission_503=0**. **Separation:** concurrent register → **503 admission**; pulse storm → **429 rate-limit**; **409 lease isolation unused**. Cgroup probe: `cgroup_fs=not_writable`, `cpu_max_write=denied` (`.ui-evidence/cgroup-probe-20261115-225235/`). API PID stable | **PASS honesty** — natural sheds without bypass; **≠** capacity-doc open-model / **≠** 10k |
| **Rate-limit fairness (bypass off)** | Dedicated API `:18191` `CF_TRUST_PROXY=true`, `CF_RATE_LIMIT_RPS/BURST=10`, **empty** bypass; `perf/k6/rate-limit-fairness.js` VUS=10 DURATION=10s public catalog — `MODE=shared` vs `MODE=xff` (distinct `X-Forwarded-For`) | **shared-IP:** 200 **109** / 429 **555** (~**83.5%** 429); **distinct XFF:** 200 **669** / 429 **0** | **PASS fairness evidence** — confirms per-IP bucket + TrustProxy; **not** learner capacity / **not** 10k |
| **Rate-limit multi-IP unit (loadtest-off)** | `go test ./internal/ratelimit/ -run MultiIPFairness`; `TrustProxy=true` + XFF/`X-Real-IP` independent bursts; **no** `LoadtestBypassExempt`; spoofed XFF ignored when `TrustProxy=false` | unit **PASS** | **PASS unit** — production fairness without bypass; complements k6 `:18191` probe |
| **Mediasim Range bandwidth smoke** | `MEDIA_URL=:18092` fixture `perf/fixtures/mediasim-range-8m.mp4` (~8.5 MiB); `perf/k6/mediasim-smoke.js` media plane only | **VUS=20/45s:** iters **14745**; range206 **10998** (~244/s); synth 429 **2280**; fail **0%**; p95 **≈0.88 ms**; ~318 kB/s. **VUS=50/60s:** iters **49189**; range206 **37004** (~**616**/s); synth 429 **7279**; custom fail **0%**; p95 **≈1.03 ms**; recv **~803 kB/s** (~48 MB) | **PASS simulator smoke** — not gateway/Odysee; not Gbps claim |
| **Media gateway Range (live `:18094`+mediasim)** | Fixture `perf/fixtures/mediasim-range-8m.mp4` (**≈8.2 MiB**); `CF_DEV_MODE`+`CF_MEDIA_SIMULATOR_URL=…/media.mp4` **only during proof** then restored. `perf/k6/gateway-range-smoke.js` sticky leases; `RANGE_MAX_START=6e6` `RANGE_CHUNK=65535` | Prior 10→48 VU. **64 VU/45s** (default MaxTransfers **64**): fail **0.18%** (20/10553); ranges ok **10385**; p95 **≈123 ms**; **≈625 MiB** gateway bytes @ **≈11517 KiB/s** (~12 MB/s k6 net); opens **84**; **busy_sheds Δ=0** (short Ranges release slots before sustained shed); range **not 5xx** checks pass | **PASS gateway through 64 VU** — hit occupancy cap without busy shed under this chunk size; not Odysee; not Gbps; FORCE restored off |
| **Observe under gateway Range load** | `scripts/scrape-observe-under-load.sh` during 10/24/32/48/**64 VU** gateway Range; forbid session/token leaks | Prior peaks 10/16/24/36. **64 VU:** max transfers **64**/64; media critical `in_use` **64**; any_nonzero **1**; **ASSERT PASS**. Short-Range mixed-plane later under-sampled xfer (**~3**); **throttled long-hold** re-raised **media_xfer=24** (see row below) | **PASS** gauges move with occupancy; natural busy shed at default **64** proven under throttled hold (see natural-64 row) |
| **Media gateway revoke (during FORCE)** | Large `/media.mp4` revoke cancel **≈0 s** (finishes before DELETE). Stall: `CF_DEV_MODE`+`CF_MEDIA_SIMULATOR_URL=…/fault/stall` on live `:18094` (FORCE during proof only); gateway `WriteHeader`+`Flush` so clients see 206 before body stall; `go run ./cmd/liverevoke -n 4` | **max_cancel ≈6.58 s**; concurrent **4**; gate ≤10s **pass=true**; FORCE restored off | **PASS stall cancel via live gateway** — mediasim only; not Odysee |
| **Observe admission scrape** | `perf/scripts/scrape-admission-metrics.sh` prefers product `:18090`/`:18094` `/metrics` (also observe `:18190`/`:18194` + `scripts/scrape-observe-gauges.sh`); forbid session/token/Odysee leaks | Caps critical **256** / pulse **512** / browse **128** / ai **32**; media transfers cap **64**; scrapers **ASSERT PASS** | **PASS wiring** — idle; see under-load row |
| **Admission scrape under sticky load** | `perf/scripts/scrape-admission-under-load.sh` @400 ms during sticky `auth-playback-openish` **VUS_MAX=20** + bypass (product `/metrics`). TSV: `/tmp/cf-admission-under-load.tsv`. API-plane k6; media peaks may include concurrent Ranges on shared host | sticky20: fail **0%**, opens **20**/pulses **20136**, open p95 **14.5 ms**, pulse p95 **17.2 ms**. Peaks: API pulse `in_use` **9**, browse/critical **1**, admission **sheds 0**; media transfers `in_use` **10**/64, media critical `in_use` **10**, busy sheds **0**; circuit open **1**, trips **4**, rejects **210** (provider path; FORCE unset during interval) | **PASS under-load scrape** — **not** capacity-doc / **not** 10k; sheds exercised in next row |
| **Intentional admission shed pressure (API)** | `CF_PRIORITY_*_SLOTS` via `ratelimit.PriorityFromEnv` (browse=2, ai=1, critical/pulse=64). Unit: `TestPriorityFromEnvShedsOnLoopbackMetrics`. Live: dedicated API `:18195` + `perf/admission-shed-live-probe.go` (slow register flood + AI `/jobs` burst); product `/metrics`; then killed (main `:18090` restored defaults 256/512/128/32) | Unit **PASS**. Live: browse capacity **2**/ai **1**; browse 429 **14**/sheds **+14**; ai 429 **19**/sheds **+19**; critical sheds **0**; critical lease opens **5/5** during flood | **PASS API shed proof** — **not** capacity-doc / **not** 10k; temporary tiny slots only |
| **Multi-replica API shed (process-local)** | Two loopback APIs `:18201`+`:18202`, identical tiny `CF_PRIORITY_*_SLOTS` (browse=2, ai=1); flood both in parallel with `admission-shed-live-probe.go`; scrape each product `/metrics`. **Not** cluster-coordinated — each process has its own limiter | **A:** browse sheds **14**, ai sheds **55**, critical **0**, leases **5/5**. **B:** browse **14**, ai **81**, critical **0**, leases **5/5**. Caps identical per process; shed counters **independent**. Replicas killed; main defaults unchanged | **PASS process-local** — proves no shared shed counter across replicas; not Redis/mesh admission |
| **Intentional media busy / admission shed** | (1) Temporary `CF_MEDIA_TRANSFER_LIMIT=2` + FORCE under `gateway-range-smoke` **16 VU/25s**. (2) Dedicated media `:18210` `CF_MEDIA_TRANSFER_LIMIT=1` + `CF_DEV_MODE`+stall simulator; `perf/media-busy-shed-probe.go` holds one Range then bursts 12; API critical lease still opens. Restore defaults | (1) capacity **2**; `busy_sheds` **+2828**; headers `X-CourseForge-Media: busy`. (2) capacity **1**; busy 503 **12**; `busy_sheds` **0→12**; hold **206**; second API lease **201** during shed. Caps restored **64** | **PASS media MaxTransfers shed** — intentional overload only; not capacity-doc / not 10k / not Odysee |
| **Natural long-held busy sheds** | MaxTransfers **16** (not 2) + stall FixedResolver. Earlier proof isolated `.env`; **re-proven** with `CF_MEDIA_FORCE_SIMULATOR=true` while root `.env` Odysee tokens remain (see FORCE row) | Hold `in_use` **16**/16; **503** busy headers; k6 fail **98.6%**; `busy_sheds` **+3516** (isolated-env run). FORCE re-proof: hold **16**, busy **503**, sheds **+2** (header probe) | **PASS natural occupancy shed** — long-held Ranges at cap; not Odysee bytes; not 10k |
| **CF_MEDIA_FORCE_SIMULATOR** | `FromEnvironment`: when `CF_DEV_MODE`+`CF_MEDIA_SIMULATOR_URL`+`CF_MEDIA_FORCE_SIMULATOR=true`, return **FixedResolver** even if Odysee accounts exist (otherwise Hybrid prefers Odysee/local). Unit: `TestForceSimulatorOverridesOdyseeAccounts`, `TestSimulatorWithoutForceKeepsHybridWhenOdyseeConfigured`, `TestForceSimulatorRequiresSimulatorURL`. Live `:18094` rebuild; `.env` **not** moved | Unit **PASS**. Live with `.env` Odysee keys present: stall Range **timeout 0 body** (not provider mp4); MaxTransfers **16** hold → **503** `X-CourseForge-Media: busy`; FORCE `/media.mp4` Range **206** 64 KiB mediasim `ftyp`; FORCE restored off | **PASS FORCE pin** — mediasim without isolating `.env`; not live CDN Range; not 10k |
| **Mixed-plane concurrent load** | Sticky API `auth-playback-smoke` **20 VU/90s** + media FORCE `gateway-range` **24 VU/90s** overlapping; `scripts/scrape-mixed-planes.sh` **INTERVAL_MS=250** `DURATION_S=100` (400 samples) on `:18190`+`:18194`. **No API restart** during run (PID stable); media-only FORCE toggle. Prior 1s scrape + API orphan restart archived as artifact | **API:** fail **0.00%**; opens **20**; pulses **13977**; pulse p95 **≈69 ms**. **Media:** fail **0.26%**; ok **17784**; **≈1071 MiB** @ **≈11651 KiB/s**; p95 **≈26 ms**. Observe peaks: api pulse **19** / http_active **20**; media xfer **3** / crit **17**; both-busy samples **92**/400; misses **0**; **ASSERT PASS**. Planes separate | **PASS clean mixed-plane** — not 10k; HF sampling shows realistic API occupancy; short Ranges still under-sample transfer slots vs critical |
| **Longer-held Ranges (transfer occupancy)** | Root cause of prior `media_xfer` peak **~2–3**: unlimited mediasim finishes **~4 MiB** in **~150 ms**. Added mediasim `-bytes-per-sec` throttle. Live: mediasim **512 KiB/s**; FORCE on `:18094` (MaxTransfers **64**); mixed sticky API **8 VU/55s** + `gateway-range` **24 VU/55s** `RANGE_CHUNK=2097151` `SLEEP_MS=0` `RANGE_TIMEOUT=60s`; scrape **INTERVAL_MS=200** `DURATION_S=70`. API PID unchanged; FORCE + unthrottled mediasim restored after | **API:** fail **0.00%** (3869 req); pulses **3828**; pulse p95 **≈44 ms**. **Media:** http fail **5.00%** (24/480; range-status checks **92%** — **0** 5xx); ok ranges **312**; gateway bytes **≈601 MiB** @ **≈9.4 MiB/s**; range avg/p95 **≈3.79 s / 4.11 s**. Observe peaks: api pulse **4** / http_active **5**; **media_xfer=24** / **media_crit=24** (held at VU count); misses **0**; **ASSERT PASS**. Prior **5%** non-5xx diagnosed as lease **409** after **~40s** without pulse (see diagnosis row); fixed via k6 pulse keepalive | **PASS long-hold occupancy** — transfer slots visible under throttle; not Odysee; not cap shed (24≪64); not 10k |
| **Natural busy shed @ MaxTransfers=64 (throttled)** | `CF_MEDIA_TRANSFER_LIMIT=64` (**not** lowered). Mediasim **256 KiB/s** + FORCE. (1) Hold+burst: **68** concurrent ~2 MiB Ranges → wait `in_use=64`, burst **40** short Ranges. (2) `gateway-range` **72 VU/35s** `RANGE_CHUNK=1572863` `SLEEP_MS=0`; scrape **200 ms**. API PID stable; FORCE + unthrottled mediasim restored | **(1)** peak **64**/64; burst **503×40** all `X-CourseForge-Media: busy` + `Retry-After`; `busy_sheds` **0→44** (Δ**44**); second API lease **201**. **(2)** peaks **media_xfer=64** / crit **72**; `busy_sheds` Δ**+18731** (matches range 5xx **18731**); ok **315**; gateway **≈455 MiB** @ **≈8.5 MiB/s**; http fail **96.5%** (expected shed). Capacity stayed **64** | **PASS natural cap shed** — default MaxTransfers without lowering limit; mediasim throttle only; not Odysee; not 10k |
| **Natural busy shed @ MaxTransfers=96** | Raised `CF_MEDIA_TRANSFER_LIMIT=96` (above default 64) + FORCE + mediasim **256 KiB/s**. Hold **110** × ~3 MiB Ranges → peak **in_use=96**/96; burst **40** short Ranges. Caps restored **64**; FORCE off; unthrottled mediasim restored | peak **96**/96; burst **503×40** `X-CourseForge-Media: busy` + `Retry-After`; `busy_sheds` Δ**+54**; hold_ok **96**; second API lease **201** during shed. API PID stable | **PASS above-64 configurable cap shed** — mediasim only; **≠** Odysee; **≠** 10k |
| **Live Odysee busy shed @ MaxTransfers=80** | FORCE **off** (Hybrid/Odysee). Controlled bump `CF_MEDIA_TRANSFER_LIMIT=80` (**above** default 64) then restore **64**. One lease + pulse; hold **90** × **1 MiB** Ranges → peak **80**/80; burst **30** short Ranges. Stop-friendly; tokens/URLs redacted | peak **80**/80; burst **503×30** all `X-CourseForge-Media: busy` + `Retry-After`; `busy_sheds` Δ**+40**; hold_ok **80**; second API lease **201** during shed. API PID stable; FORCE remained off | **PASS above-64 shed on live Odysee path** — **≠** CDN account-scale / **≠** 10k |
| **Long-hold 5% non-5xx diagnosis + fix** | Histogram on throttled **24 VU/55s** (`RANGE_CHUNK≈2 MiB`, mediasim **512 KiB/s**, FORCE): **409×24** / **206×318** / **0×503** — body `playback_conflict` (“lease is not held”). Root cause: playback lease TTL **~40s** without pulse; smoke opened once and ranged past expiry (**1×409/VU**). **Fix:** `perf/k6/gateway-range-smoke.js` sticky `playbackId` + pulse-before-Range keepalive (+ status counters). Re-run same config | **Before:** http fail **≈4.9–5.8%**, all **409**. **After:** fail **0.00%** (0/756 http; 0/366 plane); **206×318**; opens **24** (no reclaim); gateway **≈613 MiB** @ **≈9.7 MiB/s**; range avg/p95 **≈4.05 s / 4.06 s**. API PID stable; FORCE restored | **PASS explained+fixed** — harness bug not gateway admission; not Odysee; not 10k |
| **Lease TTL vs long Range (doc)** | Playback lease expires **~40s** without pulse (`playback_leases.expires_at`). Gateway `RevalidateEvery` default **3s** cancels transfers after consecutive inactive checks. Rewrite plan: unified session pulse — players heartbeat on a timer, **not** per Range chunk. k6 long-hold must pulse; product player already pulses. **No TTL change** this wave | Aligns with plan pulse unification; lengthening TTL is a product decision | **DOC only** — not a capacity claim |
| **Shed alerting examples** | `deploy/prometheus/prometheus.yml` + `courseforge-shed-alerts.yml`. **promtool 2.55.1** `check config/rules` SUCCESS. Brief local Prometheus **2.55.1** (`127.0.0.1:19090`) loaded **2** rule groups / **7** rules; `up` **1** for `courseforge-api-observe` + `courseforge-media-observe`; then stopped | Syntax + live load **PASS**; alert states inactive in short window (expected); thresholds illustrative (**not** 10k SLOs) | **PASS wiring smoke** — durable operator Prometheus still optional |
| **Durable Prometheus observe sample** | `scripts/durable-observe-prom.sh`: Prometheus **2.55.1** scrape `:18190`/`:18194`, `--storage.tsdb.retention.time=6h`, TSDB under `.ui-evidence/durable-observe-*/tsdb`. Cgroup probe records `cgroup_fs=not_writable` / no `cpu.max` (affinity≠cgroup). Evidence: `.ui-evidence/durable-observe-20261115-222614/` | api_observe **up=1**; media_observe **up=1**; transfers_capacity **64**; retention **6h** archived; cgroup pin **unavailable** | **PASS durable scrape sample** — **≠** operator multi-host / **≠** open-model / **≠** 10k |
| **Formal browser rebuffer ratio** | `web/scripts/qoe-browser-cohort.mjs` N=5; mediasim `CF_MEDIA_FORCE_SIMULATOR` during proof only then restored; ratio=`waitingMs/(waitingMs+playingMs)` after first-frame hooks (seek waiting included). Evidence: `.ui-evidence/qoe-rebuffer-20261115-205446/` | **5/5 ok**; firstFrame p50 **1541 ms**; playerReady p50 **1504 ms**; waiting events **5**/stalled **0**; waitingMs p50 **≈284**; playingMs p50 **≈1218**; ratio p50 **≈0.189** / p95 **≈0.279** | **PASS sampled formal ratio** — mediasim only; **not** capacity-doc rebuffer gate / not Odysee |
| **Formal browser rebuffer N=10** | `web/scripts/qoe-browser-cohort.mjs` **N=10** Chromium; mediasim FORCE during proof; evidence `.ui-evidence/qoe-rebuffer-n10-20261115-220241/` | **10/10 ok**; firstFrame p50 **749 ms**; playerReady p50 **707 ms**; rebuffer ratio p50 **≈0.452** / p95 **≈0.460** (seek-wait included); seekOk **10/10**. FORCE restored | **PASS sampled N=10** — mediasim only; **not** capacity-doc rebuffer gate / not Odysee |
| **Formal rebuffer ex-seek (capacity-doc aligned sample)** | `web/scripts/qoe-browser-cohort.mjs` now tracks `waitingMsExSeek`/`playingMsExSeek` + `seekWallMs` (seek windows excluded). N=5 Chromium; mediasim FORCE during proof only then restored; **QOE_STEADY_MS=8000** + seek separately. Evidence: `.ui-evidence/qoe-rebuffer-exseek-20261115-222306/` | **5/5 ok**; firstFrame p50 **573 ms**; playerReady p50 **479 ms**; seekOk **5/5**; seekWall p50 **≈57 ms**. legacy ratio p50 **≈0.041** / p95 **≈0.050**; **ex-seek** ratio p50 **≈0.041** / p95 **≈0.050** (steady window dilutes seek). API PID stable; FORCE restored | **PASS sampled ex-seek ratio** — mediasim only; **≠** capacity-doc gate (needs 5‑min×≥100 sessions / p95&lt;1%); **≠** Odysee; **≠** 10k |
| **Fail-closed rebuffer gate (stepped)** | `web/scripts/qoe-rebuffer-gate.mjs` over cohort: asserts shell selectors (`#email`/`#password`/`Continue`/`#featured-course .hero-play`), requires `ratioExSeek` on every ok run, fail-closed on missing summary. Clock harden: arm play/wait clocks **after first frame** (already-playing miss fixed). Stepped: N=20, steady **8s**, hold 1s, stepped p95 threshold **0.05**. Prior broken-clock N=20@4s / N=10@20s archived as fail-closed evidence (inflated ratios). FORCE mediasim during proof only then restored. Evidence: `.ui-evidence/qoe-rebuffer-gate-stepped-n20-fixed-20261115-223422/` | **STEPPED PASS** 20/20 ok; firstFrame p50 **565 ms**; ratioExSeek p50 **≈0.0078** / p95 **≈0.0127**; playingEx p50 **≈8985 ms**. **FULL_GATE FAIL** (need N≥100 + steady≥300s + p95&lt;1%; observed p95 **≈1.27%** on 8s×20). API PID stable; FORCE off | **PASS stepped path** — **≠** capacity-doc full rebuffer gate / **≠** Odysee / **≠** 10k |
| **Fail-closed rebuffer mid-step (60s×10)** | Same gate harness; mediasim FORCE during proof only. **N=10**, **QOE_STEADY_MS=60000**, hold 1s; stepped threshold 0.05. Delta vs full: N≪100, steady **60s≪300s**. Evidence: `.ui-evidence/qoe-rebuffer-gate-midstep-n10-60s-20261115-231701/` | **STEPPED PASS** 10/10 ok; ratioExSeek p50 **≈0.0010** / p95 **≈0.0013** (**&lt;1%** on this window). **seekOk=false on all 10** — root cause: mediasim fixture duration **=60s** + ArrowRight **+10s** at EOS (harness, not player regression). **FULL_GATE still FAIL** (N/steady short). API PID stable; FORCE off | **PASS mid-step ≠ full gate**; seek trap documented |
| **QoE seekOk fix (EOS headroom)** | `qoe-browser-cohort.mjs`: before ArrowRight, rewind when `duration-currentTime < 15` so +10s seek can advance after long steady. Re-smoke **N=3** × **60s** steady, mediasim FORCE then restored. Evidence: `.ui-evidence/qoe-seekfix-n3-60s-20261116-005316/` | **3/3 seekOk=true** / ok; firstFrame p50 **599 ms**; ratioExSeek p95 **≈0.0088**. API PID stable; FORCE off | **PASS harness fix** — mid-step seekOk false explained+fixed; **≠** full gate |
| **Browser WebKit QoE N=1** | `npx playwright install webkit`; `BROWSER=webkit N=1` `qoe-browser-cohort.mjs`; mediasim FORCE during proof only then restored. Evidence: `.ui-evidence/qoe-webkit-n1/` | **1/1 ok**; firstFrame **5788 ms**; playerReady **5756 ms**; seekOk; rebuffer hooks **0** waiting in short observe window | **PASS sampled WebKit** — mediasim only; not capacity-doc / not Odysee / not mobile |
| **Jobs terminal prune** | `PruneTerminalJobs` 14d retention, batch 500; `Queue.IdleMaintenance` parks exhausted outbox + prunes delivered outbox/terminal jobs; **wired** in `cmd/worker` idle claim path (`IdleMaintenanceInterval` 30s) | unit + race | **PASS** terminal job retention (no Ollama); idle wiring closed |
| **Player QoE telemetry prune** | `playback.PruneTelemetry` 7d retention, batch 500; does not touch watched totals/sessions | unit tests | **PASS** bounded `player_telemetry` retention |
| **Retention cleanup seam** | `internal/retention.Cleanup` + `IdleSweep` (DrainOrder); wired in `cmd/worker` idle path beside jobs `IdleMaintenance`. No HTTP cleanup route / no API startup. Admin `scheduler_status=worker_idle` | unit + admin honesty | **PASS** RETENTION_CONTRACT SQL seam + worker idle runner |
| **Playback auth FK + snapshots** | Migration `038_playback_auth_retention.sql`: drop `playback_sessions.auth_session_id` CASCADE FK; immutable `device_snapshot`/`ip_snapshot`/`snapshot_basis`/`snapshot_truncated`; open captures `session_open`; BEFORE DELETE on `auth_sessions` closes bindings without wiping detail; admin playback report uses snapshots | unit + admin/activity regression | **PASS** login delete preserves native detail + totals; live pulse denied |
| **Auth revoke closes bindings** | Migration `039_auth_revoke_close_bindings.sql`: shared `auth_session_close_bindings`; AFTER UPDATE OF `revoked_at` (NULL→set) closes native/activity + clears leases; idempotent when already revoked | playback + admin unit | **PASS** revoke closes without wiping detail/totals; admin report/CSV keep open-time snapshots |
| **Admin snapshot evidence** | `TestAdminPlaybackReportUsesNativeSnapshotsAfterLoginDelete` — JSON `device`/`ip`/`device_basis=session_open` after auth DELETE; CSV contains snapshot values, not “Current login device” | unit | **PASS** |
| **Browser admin snapshot proof** | `web/scripts/admin-snapshot-proof.mjs` Chromium: learner UA open → SQL admin promote → auth revoke → admin UI Live Activity table + CSV download; applied live migrations 038/039 (API `CF_MIGRATE=false`); rebuilt `bin/courseforge-api`. Evidence `.ui-evidence/admin-snapshot/` | Playwright hybrid | **PASS sampled** — mediasim/player path; not Odysee; not 10k |
| **Desktop `#nav-admin` visible** | Removed cinema-rail `display:none` for `#nav-admin`; dropped `lms-secondary-mobile` so admin-capable users get a primary desktop rail entry (mobile secondary items unchanged). Proof waits for **visible** `#nav-admin` (no hidden force-click) | Playwright re-proof | **PASS** `.ui-evidence/admin-snapshot/2026-11-15T16-11-09-802Z-summary.json` |
| **Browser rebuffer sample** | QoE N=1 with `waiting`/`stalled` hooks + 1.2s post-seek hold (mediasim) | waiting **1** / stalled **0** / waitingMs **≈15**; seekOk; ok | **PASS sampled** — not capacity-doc rebuffer ratio / not Odysee |
| **Browser rebuffer cohort** | QoE N=5 mediasim FORCE + hooks; media restored after | **5/5 ok**; firstFrameMs **623/713/809**; playerReadyMs **563/663/738**; waiting **1/run** (sum 5), stalled **0**, waitingMs **≈15–52** (p50 ~19) | **PASS sampled** — mediasim only; not capacity-doc rebuffer ratio / not Odysee |
| **Cgroup note** | `cgcreate`/`cpu.max` under `/sys/fs/cgroup` **denied** for ubuntu; `systemd-run --user -p CPUQuota=100%` client-scope smoke 15s | ok **114** / fail **0** | **Honesty: affinity≠cgroup**; client scope ≠ pinned API process; no durable API `cpu.max` |
| **Provider-direct delivery** | — | — | **Blocked by design** until revoke soak + short-lived authz proof exist; keep authorize-then-proxy (see §7) |

Larger operator ramp still: `perf/k6/read-load.js` (defaults toward high VUs — do not treat a local smoke as that run).

| Verdict | Harness / entry | Cloud Agent status after this run | Still required for a full capacity-doc verdict |
| --- | --- | --- | --- |
| Application (API) | openish + **no-bypass shed separation** + mixed-plane | Pulse storm **429×54053** / **409×0**; register ladder **503**; cgroup **unwritable** | Capacity-doc open-model (cgroup/multi-host/full mix at target) |
| Media simulator | FORCE + mixed-plane + natural-64 + **natural-96** shed | Clean mixed **24 VU** ~11.4 MiB/s fail **0.26%**; long-hold **5%** was lease **409** (no pulse) → **0%** after k6 keepalive; natural-64 shed proven; **natural-96** peak **96**/96 busy Δ**54** | Simulator path closed for local proofs; live Odysee separate row |
| Observe | HF mixed-plane + **durable Prom 6h TSDB sample** + natural-64 | Durable sample **up=1** both planes; natural-64 **xfer=64**; cgroup **not_writable** | Operator multi-host Prom; true `cpu.max` pin |
| Sampled browser | mid-step 60s×10 + **seekOk EOS fix N=3** + WebKit N=1 | Mid-step p95 **≈0.0013**; seekOk trap fixed **3/3**; **FULL_GATE open**; WebKit N=1 | Capacity-doc 5‑min×100, mobile, live Odysee cohort |
| Migration importer | `cmd/migratecutover` + migrate v1–v7 + tiny artifact fixtures + throwaway schema | **PASS** CLI DryRun/Apply rehearsal + fixture file presence; refuses live sqlite | Real isolated production snapshot; full binary/frame/Qdrant/lab workspace recovery; Odysee/Ollama |
| Live Odysee | sustained 64×75s + **MaxTransfers=80 busy shed** (FORCE off) | Sustained **0%** fail; Odysee cap-80 peak **80**/80 busy Δ**40** | Broader CDN/account scale; capacity-doc 10k |
| AI / jobs | `cmd/worker` idle `IdleMaintenance` + outbox/terminal prune | **Outbox + terminal prune + idle wiring PASS** (unit/race); live AI **Blocked** (no Ollama) | Synthetic queue age + lease reclaim + real executor |
| Postgres pool fleet | `store.DefaultExperimentLayout` / ceiling 120 | Unit-tested planner only | Confirm DB `max_connections` before replica scale-out |

Publish **separate** API / media / AI / (optional live) verdicts. Passing module tests or this research doc is not a 10k-learner claim.

---

## 6. Source index (primary)

### CourseForge

- [docs/GO_TYPESCRIPT_REWRITE_PLAN.md](../GO_TYPESCRIPT_REWRITE_PLAN.md) — architecture, modules, Odysee, 10k as target  
- [docs/GO_TYPESCRIPT_CAPACITY.md](../GO_TYPESCRIPT_CAPACITY.md) — workloads, gates, separate verdicts  
- [docs/GO_TYPESCRIPT_AGENTS.md](../GO_TYPESCRIPT_AGENTS.md) — agent roles / verification protocol  
- [AGENTS.md](../../AGENTS.md) — isolation, credentials, capacity reporting rules  
- [docs/MEDIA_DELIVERY.md](../MEDIA_DELIVERY.md) — HLS/progressive caching policy  
- [docs/rewrite/JOBS_CONTRACT.md](../rewrite/JOBS_CONTRACT.md) — durable jobs  
- `backend/internal/{api,playback,media,jobs,...}`, `backend/cmd/{api,media,worker,...}` — package map  

### Netflix (first-party)

- [Open Connect Overview (PDF)](https://openconnect.netflix.com/Open-Connect-Overview.pdf)  
- [Driving content delivery efficiency through classifying cache misses](https://netflixtechblog.com/driving-content-delivery-efficiency-through-classifying-cache-misses-ffcf08026b6c)  
- [How data science helps power worldwide delivery of Netflix content](https://netflixtechblog.com/how-data-science-helps-power-worldwide-delivery-of-netflix-content-bac55800f9a7)  
- [Engineering trade-offs and the Netflix API re-architecture](https://netflixtechblog.com/engineering-trade-offs-and-the-netflix-api-re-architecture-64f122b277dd)  
- [Enhancing Netflix reliability with service-level prioritized load shedding](https://netflixtechblog.com/enhancing-netflix-reliability-with-service-level-prioritized-load-shedding-e735e6ce8f7d)  
- [Edge authentication and token-agnostic identity propagation](https://netflixtechblog.com/edge-authentication-and-token-agnostic-identity-propagation-514e47e0b602)  
- [Scaling time-series data storage Part I](https://netflixtechblog.com/scaling-time-series-data-storage-part-i-ec2b6d44ba39) / [Part II](https://netflixtechblog.com/scaling-time-series-data-storage-part-ii-d67939655586)  
- [Rebuilding Netflix video processing pipeline with microservices](https://netflixtechblog.com/rebuilding-netflix-video-processing-pipeline-with-microservices-4e5e6310e359)  
- [Per-title encode optimization](https://netflixtechblog.com/per-title-encode-optimization-7e99442b62a2)  
- [Netflix cloud packaging in the terabyte era](https://netflixtechblog.com/netflix-cloud-packaging-in-the-terabyte-era-d6869b4b84ae)  
- [Lessons from building observability tools at Netflix](https://netflixtechblog.com/lessons-from-building-observability-tools-at-netflix-7cfafed6ab17)  

### YouTube / Google (first-party)

- [Reimagining video infrastructure to empower YouTube](https://blog.youtube/inside-youtube/new-era-video-infrastructure/)  
- [Google I/O 2013 – Adaptive Streaming for You and YouTube](https://www.youtube.com/watch?v=UklDSMG9ffU)  
- [Preference learning with automated feedback for cache eviction](https://research.google/blog/preference-learning-with-automated-feedback-for-cache-eviction/)  
- [HALP publication page](https://research.google/pubs/halp-heuristic-aided-learned-preference-eviction-policy-for-youtube-content-delivery-network/)  
- [Information sharing for more efficient network utilization and management](https://research.google/blog/information-sharing-for-more-efficient-network-utilization-and-management/)  
- [Prequal publication page](https://research.google/pubs/load-is-not-what-you-should-balance-introducing-prequal/)  

### Specs / standards

- [RFC 8216 – HTTP Live Streaming](https://www.rfc-editor.org/rfc/rfc8216)  
- [Apple HLS authoring specification](https://developer.apple.com/streaming/hls-authoring-specification-for-apple-devices.html)  
- [Apple HLS 2nd Edition draft](https://developer.apple.com/streaming/HLS-draft-pantos.pdf)  
- [ISO/IEC 23009-1 (MPEG-DASH)](https://www.iso.org/standard/23009-1)  
- [DASH-IF Interoperability Guidelines V5](https://dashif.org/guidelines/iop-v5/)  

### FakeTube / AWS (first-party to those projects)

- [FakeTube #1 – Build YouTube Clone with AWS](https://faketube.dev/blog/build-youtube-clone-with-aws)  
- [FakeTube #5 – Videos REST API](https://dev.to/jacekkosciesza/videos-rest-api-with-api-gateway-lambda-aurora-serverless-faketube-5-1102)  
- [FakeTube #6 – Videos GraphQL API](https://dev.to/jacekkosciesza/videos-graphql-api-with-appsync-lambda-dynamodb-faketube-6-2jcb)  
- [AWS Elemental MediaConvert documentation](https://docs.aws.amazon.com/mediaconvert/)  
- [MediaConvert ABR / output groups](https://docs.aws.amazon.com/mediaconvert/latest/ug/outputs-file-ABR.html)  

### Explicitly excluded secondary material

Reverse-engineering papers (e.g. academic “vivisecting YouTube CDN” talks), SEO roundups, and third-party “how Netflix works” blogs were not used as claim sources. Where Google/YouTube session-ownership detail is thin, that gap is called out rather than filled from secondary summaries.

---

## 7. Gaps and caveats

- **FakeTube:** Primary sources are tutorial/architecture blogs + AWS docs; thin on concurrent session ownership, LMS-style enrollment, and measured scale.  
- **YouTube session/lease semantics:** No strong first-party public equivalent to CourseForge’s takeover/credit rules.  
- **Odysee:** Not a Netflix/YouTube open architecture; CourseForge must treat provider bitrate, ABR availability, and concurrency limits as **unknown inputs** (rewrite “decisions still needed”).  
- **10k figure:** Remains a design target until M4 evidence exists; this document does not estimate hardware sizing.  
- **DASH:** Spec-complete; CourseForge currently ships HLS + progressive—adding DASH is optional packaging, not required for the Go rewrite’s correctness.
- **Provider-direct delivery (still blocked):** Handing the browser a raw Odysee/CDN URL would bypass lease revalidation and make enrollment/session revoke non-recallable. CourseForge keeps **authorize-then-proxy** (`internal/media` gateway): same-origin `media_url` / HLS paths only; credentials and upstream URLs stay server-side. Unblock criteria: (1) gateway+auth revoke ≤10s proven under load, (2) short-lived client capability tokens with server-enforced TTL, (3) product decision that residual buffered-bytes after revoke are acceptable. Until then, strengthen proxy admission (`MaxTransfers`, `X-CourseForge-Media: busy|no-source`) rather than steering.
