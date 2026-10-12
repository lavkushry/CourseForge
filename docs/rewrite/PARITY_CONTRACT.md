# Full rewrite parity gates

The 164 legacy method/path pairs in `LEGACY_ROUTE_INVENTORY.json` are the route
scope. These gates supplement the detailed M1/M2 clauses in `M1_CONTRACT.md`.
An implemented slice cannot waive another slice or the artifact/vector recovery
contract. Every route needs a documented new route or an explicit reviewed
replacement, public positive/negative behavior evidence and a persistence semantic
comparison where applicable. Candidate legacy test ownership is not a coverage
claim; all unverified route gates remain pending.

## Common gate for every protected route

Use at least two synthetic students and an administrator, with different course
permissions and overlapping lesson IDs. Prove guest denial, verified/active
account state, caller role, course publication/enrollment and the explicit
learner predicate. Exercise missing/wrong CSRF and hostile Origin for mutations.
Return bounded documented errors for invalid IDs, malformed inputs and pressure;
never leak another learner's record, note, assessment, task, token or credential.

Every acknowledged write must survive the demonstrated restart/retry contract.
Retried commands must not duplicate completion/recall credit or artifacts. Lists,
searches and exports must be bounded and ordered, with tested page boundaries and
stable IDs. Migrate preserved timestamps, ordering, preferences and ownership.
Compare transformed values semantically rather than merely matching row counts.

## Slice requirements and authoritative evidence

| Slice | Observable behavior that must be retained | Required proof |
| --- | --- | --- |
| Identity/access | Registration modes, normalization, account activation/verification, single-use invitations and recovery, password changes, sessions, CSRF/origin, account edits/deletion, roles, last-admin protection, enrolled/published course scopes and cross-replica revocation. Retain compatible Argon2 password hashes without plaintext export. | M1 clauses plus registration/invitation/reset/admin positive/negative HTTP checks; public state after fresh login; importer hash compatibility; revoke checks across replicas; synthetic deletion and retained-aggregate comparison |
| Catalog/discovery | Public/private catalog, course and lecture metadata/order, source/provider mappings, publication, artwork, lesson organization, materials and safe downloads, streaming home/browse/title/search, continue-watching, trending, private list/history and bounded analytics. Preserve stable original folder/course/lesson IDs. | Every catalog/streaming route mapping; ordered page and unauthorized material checks; deterministic browser browse/title/search/list flows; content/artifact checksums and stable-source-ID semantic import comparisons |
| Player | Native and embedded session/capability behavior, shared tab ownership, deliberate takeover, ranges, restricted redirects, pre-range preparation, cancellation/revoke, resume/restart/preferences, private playback reports and export, position/coverage/activity separation and duplicate-safe durable pulses. Correct autoplay preference/ended timing. | All M2 clauses; simulator faults; real decodable browser sessions in three engines; sample-only live Odysee report separate from provider-approved scale; migration coverage intervals and lifetime totals |
| Learning records | Explicit progress/resume, notes/bookmarks, review cards/scheduling/grades, lesson quizzes and topic assessments/attempt history, learning paths/steps, adaptive practice/recommendations/history, brief/smart resume, interview/placement practice, completion/review credit and certificate issuance/verification. Preserve source citations and private feedback. | Two learners create/read/update each record type via public interfaces; invalid ownership and repeated command probes; timezone/due/order boundaries; certificates tied to actual requirements; stable-ID/timestamp/result semantic migration comparisons |
| Planning/habits | Daily and weekly preferences/plans/items/actual time, focus active/history/actions/analytics, studio insights, activity, habits/engagement/retention metrics and preferences. Keep focus time, planning actual time, visible-page activity and played/watched time distinct. | Deterministic clock plus actual public lifecycle checks; hidden/pause/resume/end/retry probes; local-day/week/timezone/DST tests; private history; migrated totals and preferences compared independently |
| AI/import | Scan/reindex/import, durable queue/tasks, tutor retrieval/answer modes, generated syllabus/learning path/assessment/review content, transcription/OCR/vision/embedding, source citations/timestamps and companion behavior. Python adapters consume Go-owned versioned jobs rather than mutating old SQLite. | Synthetic job state/results via API and real bounded adapter execution where available; worker kill/retry/lease-expiry fencing; no duplicate publication; provider errors/timeouts/retry limits; restored artifacts and versioned vector retrieval citations |
| Labs | Curated lab catalog/tracks/session files/submissions/graders and learning-path recommended practice. Sandbox and resource limits, cancellation, private state/results and repeat-safe task completion remain explicit. | Public curated workflow and cross-user denial; actual isolated runner execution; timeout/cancel/resource probes; worker death and stale fenced result publication; migrated file/artifact/session references |
| Administration | Overview/users/detail/controls, invitations/account links, suspension/session/enrollment/role/publication/provider changes, materials/organization, quiz curation, teacher insights, provider/system checks, playback/activity/streaming analytics and exports. Keep bounded exports, CSV protections, audit redaction, deletion/retention and retained aggregates. | Student denials for every admin route; two replicas observe each revoke; audit carries no secrets; spreadsheet-safe exported fixture values; large export queued/bounded; cleanup/deletion migration semantics and restore evidence |
| Delivery/operations | Existing UI and responsive layout, static builds/cache refresh, service worker private API/media exclusions, health/readiness, operational logs/metrics/traces and private profiling, safe deployment, backup/restore and release checks. | User-visible desktop/mobile/browser checks; stale asset refresh; production config checks; dependency readiness/shutdown/drain/fault probes; complete SQL/artifact/vector/job backup and post-write recovery rehearsal |

## Migration and recovery gates

Keep Python/SQLite authoritative until the rehearsed cutover. Do not create two
production writers for the same learner record. Import only consistent snapshots,
preserving IDs, ownership, provider mappings, notes, position, explicit completion,
coverage intervals, assessments, history, aggregates and artifact references.
Record FTS rebuild and session invalidation behavior. Check counts, foreign keys,
stable-content checksums, transformed-value semantics and Argon2 compatibility.

Pause/drain workers before snapshotting artifacts, vector generations and job
checkpoints, or demonstrate deterministic rebuilding from preserved sources.
Rehearse backup restore and verify both SQL state and retrieved citations/material
access. Before new writes rollback may restore old routing. After new writes,
prove replay/reverse recovery or maintenance/fix-forward; simply switching to old
SQLite does not preserve newly acknowledged writes.

## Capacity and production readiness gates

`GO_TYPESCRIPT_CAPACITY.md` governs offered/completed workloads, latency, error,
durability, fairness, bounded memory/concurrency and failure recovery. The API,
realistic simulator delivery, decoded browser playback, live Odysee and AI/lab
queues have separate verdicts. Short HTTP tests or tiny media bodies cannot prove
end-to-end 10k learners. Name hardware, geography, pool/replica budgets, provider
limits, generator saturation and cost; obtain repeated sustained/soak/fault evidence.

Production release requires all parity, migration/recovery, device and capacity
gates, a measured maintenance window and an agreed deployment/provider envelope.
Until those inputs and their evidence exist, report precise incomplete gates
instead of claiming a production-ready rewrite from M1/M2 alone.
