# M1 behavior contract and M2 playback handoff

This contract is written from the rewrite plan and observable legacy behavior.
It defines acceptance; it does not claim the new implementation already passes.
Use synthetic fixtures in the isolated Go/PostgreSQL stack. Production learner
data, credentials, sessions, services and Odysee traffic are outside this gate.

## Fixture and public surfaces

Create two independent verified students, Alice and Bob, an unverified student,
a suspended student and an administrator. Use two published courses and one
unpublished course. Give each course two stable lesson IDs and known durations.
Enroll Alice in the first course and Bob in both published courses. Keep the
unpublished course unavailable to students. Capture only fixture IDs, response
statuses and state summaries; redact cookies, passwords, CSRF and media tokens.

Bind the contract to the versioned API/OpenAPI endpoint map before exercising it.
Legacy names below describe the behavior being migrated; the selected Go route
and response shape must be documented if different. Do not silently discard
these semantics because an endpoint has a new name.

The coordinator's current documented Go surface binds this contract as follows:
`/health/live` and `/health/ready` are public; application routes use `/api/v1`.
Identity uses `/auth/register`, `/auth/login`, `/auth/logout` and `/me`. Catalog
uses `/courses`, `/courses/{id}` and POST `/courses/{id}/enroll`. Lessons use
`/lessons/{id}`, `/progress`, PUT `/lessons/{id}/progress`, GET/POST
`/lessons/{id}/notes` and DELETE `/lessons/{id}/notes/{note_id}`. Note creation
requires `Idempotency-Key`. Authenticated mutations require `X-CSRF-Token` and
the configured frontend Origin. Local development permits an insecure cookie;
production HTTPS must use Secure cookies. Exact administrative route binding is
recorded with the verification report when documented and exercised.
PUT `/lessons/{id}/resume-point` saves a position while preserving completion.
The progress request accepts `position`, optional `percent` and optional
`expected_revision`. `percent:100` sets explicit completion; a lower supplied
percent clears manual completion. The `completed`/`explicit_completed` fields are
response fields, not request fields. A position-only update preserves completion.
Published discovery and preview use `/public/courses` and
`/public/courses/{id}`; private `/courses` is enrolled-only for students.

| Clause | Action and required result | Evidence and legacy reference |
| --- | --- | --- |
| M1-01 Login | Correct password returns the correct public user and a fresh cookie session. Wrong password and unknown email fail without exposing password hashes. Cookie is HttpOnly and SameSite=Lax; Secure is required in production HTTPS configuration. Previous session cannot be substituted to authenticate another account. | Public HTTP responses and cookie attributes, sanitized; `test_cookie_and_unauthenticated_boundary`, `test_accounts_verification_reset_csrf_sessions` |
| M1-02 Account state | Guests cannot read/write private catalog or learner state. Suspended accounts cannot authenticate or use an existing session. Unverified students cannot enroll/read protected lessons. Student callers cannot grant themselves roles or verification. | Guest, unverified, suspended and student calls; before/after state; `test_student_admin_and_course_boundaries`, `test_suspension_and_revocation_take_effect` |
| M1-03 CSRF and origin | Every authenticated state-changing call rejects absent/wrong CSRF tokens and hostile Origin. Correct same-origin calls succeed. Login enforces the documented origin policy even before a session exists. Rejected mutations leave stored state unchanged. | Repeat enrollment/progress/note/logout with each token/origin variation; `test_accounts_verification_reset_csrf_sessions`, `test_registration_validates_input_and_rejects_cross_origin` |
| M1-04 Catalog/enrollment | Public catalog shows published courses only. Private course/lesson lists contain only allowed content. Published-course self-enrollment is idempotent and immediately enables its lessons; unpublished course enrollment is denied. Revoked enrollment immediately removes lesson access. Preserve original IDs and ordering. | Lists, detail, pagination and explicit forbidden lesson call; `test_student_admin_and_course_boundaries` |
| M1-05 Progress durability | Alice saves position and explicit progress/completion, receives an acknowledgement only after durable storage, signs in again and reads the same values. Bob's progress stays unchanged. Repeat the write and verify no duplicate completion credit. Invalid finite/range/duration values fail without mutation. Manual resume changes position while preserving prior completion. | HTTP write/read, fresh session, repeated write, invalid payloads; `test_progress_notes_bookmarks_are_independent`, `test_manual_resume_preserves_completion_and_is_private` |
| M1-06 Notes isolation | Alice writes a timestamped note, refreshes and reads it. Bob sees only his notes and cannot delete Alice's note using its ID. Alice can delete her note; deletion is durable. Blank/oversized/non-finite payloads are rejected. Course revocation prevents subsequent access. | Alice/Bob notes lists and delete response; `test_progress_notes_bookmarks_are_independent` |
| M1-07 Revocation across replicas | Logout, administrative session revoke and account suspension make the old cookie unusable on every replica. Enrollment revoke denies the next course-specific call across replicas. Role changes revoke existing sessions; the last administrator cannot be removed. | Repeat calls against two API replicas after authoritative mutation; `test_suspension_and_revocation_take_effect`, `test_role_changes_require_admin_password_and_revoke_access`, `test_last_admin_and_pending_account_role_guard` |
| M1-08 Input/overload bounds | Reject oversized bodies, unsupported fields/types where the published schema disallows them, non-finite numbers and unbounded pagination. Dependency outages return documented errors within a bounded deadline. Admission pressure returns bounded retry responses; after pressure drops, useful requests recover. Authentication strength is preserved. | HTTP payload/boundary probes and isolated saturation/recovery, with actual configuration recorded |
| M1-09 Persistence/restart | Stop/restart the isolated API without reseeding; the acknowledged note and progress survive. Restart PostgreSQL with durable storage; committed data remains. Two concurrent users on the same lesson cannot overwrite each other's state. | Saved acknowledgement IDs and reads after restart, concurrent HTTP writes; database initialized only before the test |
| M1-10 Operations | Liveness and readiness have distinct dependency semantics. Graceful shutdown finishes bounded operations and rejects/drains new work. Logs and metrics expose useful request/error signals while hiding credentials and private note text. | Public health/readiness responses, operator shutdown and redacted logs |

M1 may hand off playback interfaces before M2 is complete. A passing M1 report
must state which playback clauses below are still unverified rather than marking
the entire rewrite as done. Pending registration/invitation/recovery, broad
learning/admin parity, importer, durable jobs and production rollout remain M3–M5.

## Planned playback interface clauses

| Clause | Behavior to preserve or correct | Required observable proof |
| --- | --- | --- |
| M2-01 Ownership | Opening a lesson acquires one shared learner playback lease. A second tab requires deliberate confirmed takeover. A stale/displaced tab cannot reclaim through reconnect/heartbeat or receive watch credit. | Two browser tabs/API sessions, two API replicas, conflicting concurrent claims |
| M2-02 Pulse accounting | Versioned pulse carries sequence, ownership, visible page state, playback state, position and elapsed separately. Same packet retried after lost acknowledgement has one effect. Duplicate/reordered packets cannot add credit. Seeking to the end is not watched coverage; pauses do not add watch seconds. | Deterministic clock/media and ordered/duplicated/reordered HTTP events; compare position, coverage, watch seconds and page activity independently |
| M2-03 Durable acknowledgement | Every accepted sequence is durable before acknowledgement. Lost response followed by retry returns the same logical outcome. API crash/restart cannot lose acknowledged credit or apply it twice. | Capture acknowledgement/sequence IDs, kill/restart API, read state and retry |
| M2-04 Lifecycle | Hidden/offline/disposed/displaced player pauses and releases ownership. Reclaim follows deliberate user action. Disposal aborts lesson requests/retry timers. A stale response cannot change a newer lesson. Terminal 401/403 cancels retries. Queue exhaustion is bounded and visible. | Browser/network/lifecycle controls plus injected transport and clock tests |
| M2-05 Autoplay | Disabled autoplay never navigates automatically. Enabled autoplay starts its cancellable countdown only after the real `ended` event, then opens the next authorized lesson. | Real deterministic decodable browser playback and cancellation/next-lesson assertions; early near-end navigation is not accepted legacy parity |
| M2-06 Native browser controls | Speed, volume, seek, resume/restart, captions when available, fullscreen/theater, keyboard/touch, watermark, timestamp capture, materials and fallback controls remain usable. Drawer focus and mobile layouts work. Embedded capabilities honestly describe unavailable native tracking/seek guarantees. | Chromium/Firefox/WebKit browser checks with fixture video; real mobile-device checks remain a separate release gate |
| M2-07 Authorized bytes | Session/media path is bound to account, login session, lesson, enrollment and ownership. Browser cannot receive Odysee account credentials or source URLs. HEAD, Range, 206/416, allowed redirects, type checks and pre-range preparation preserve protocol behavior. | Independent deterministic provider simulator and unauthorized account/lease calls |
| M2-08 Revocation during stall | Enrollment/account/lease revoke denies the next request and cancels active delivery within 10 seconds even when the upstream sends no more chunks. Already buffered bytes are excluded from this server guarantee. | Simulator holds a stream open without chunks; revoke and observe independent cancellation timer |
| M2-09 Provider limits | Resolution is deduplicated and separate from bounded transfers. Provider 429/503, slow/truncated streams and approved redirects use bounded backoff/retries/cancellation. API remains responsive while transfer budget is full. | Fault-capable simulator, captured retry/admission/cancellation observations, sustained response-body streaming |

## Deterministic provider simulator specification

Use a locally generated playable MP4 with known duration and checksum. Support
HEAD and single byte ranges, including prefix, suffix and open-ended ranges. Full
GET returns 200 and Content-Length; valid range returns 206, Content-Range and
Accept-Ranges; unsatisfiable/multiple ranges return the documented 416 behavior.
Do not claim decoding or bandwidth evidence from a tiny placeholder response.

Provide explicit fixture modes for preparation required before Range, approved
redirect, forbidden redirect, 429 with Retry-After, 503, slow chunks, indefinite
stall, mid-body truncation and client cancellation. Use local mock origins with
an explicit test allowlist; production must retain its provider restrictions.
High-volume load stays on this simulator until an Odysee test envelope is agreed.

## Required report and remaining measurement gates

Record each clause as pass, fail, blocked or pending with the exact public action,
configuration, fixture, hardware and evidence path. A source-string test cannot
prove a browser clause. A unit test cannot prove cross-replica revocation or
PostgreSQL crash durability. Test names above are legacy references, not coverage
claims for the Go implementation.

Run Go race/unit tests, PostgreSQL integration and public HTTP checks for M1. M2
adds actual browser and gateway fault checks. Load results must follow
`docs/GO_TYPESCRIPT_CAPACITY.md`; finite fixture checks do not establish the
10,000-learner, realistic media-delivery, live Odysee or AI-throughput targets.
