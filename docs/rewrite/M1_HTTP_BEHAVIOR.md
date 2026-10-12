# Go HTTP behavior validation

The current scoped HTTP observations have no remaining failures: 116 distinct
cases in `M1_HTTP_BEHAVIOR.json` pass, and a separate coordinated graceful
API/PostgreSQL restart checkpoint passes all five readbacks. This is correctness
evidence for the documented interface, not production readiness or capacity proof.

The verifier used the prewritten `M1_CONTRACT.md` and operator-supplied public API
binding without inspecting Go implementation source. The target was the isolated
`courseforge_rewrite` PostgreSQL stack, loopback API ports 18090/18091 and frontend
Origin `http://127.0.0.1:5173`. It registered unique synthetic students and changed
only those students' state. Bootstrap fixtures remained available to browser tests.

## Reproduction and evidence

Supply synthetic fixture values through environment variables. Reports omit
passwords, cookies and private note bodies:

```bash
# CF_VERIFY_PASSWORD, CF_VERIFY_ADMIN_EMAIL, CF_VERIFY_ADMIN_PASSWORD,
# CF_VERIFY_UNVERIFIED_EMAIL and CF_VERIFY_ORIGIN must already be configured.
.venv/bin/python scripts/rewrite_verify.py --replica http://127.0.0.1:18091 --output docs/rewrite/M1_HTTP_BEHAVIOR.json
```

| Evidence | Result and interpretation |
| --- | --- |
| `M1_HTTP_BEHAVIOR_RUN1.json` | Initial setup omitted registration's CSRF token before re-login. Retained as harness setup evidence, not 33 independent product bugs. |
| `M1_HTTP_BEHAVIOR_RUN2.json` | 56/60 passed: two temporary registration status differences and two related out-of-duration progress/state assertions failed. |
| `M1_HTTP_BEHAVIOR_RUN3.json` | 84/86 passed with the documented temporary registration200 binding. Only out-of-duration acceptance and its changed-state readback failed. |
| `M1_HTTP_BEHAVIOR_RUN4.json` | Rebuilt API: 108/112 passed. Registration201, published/public and enrolled/private catalog, revision conflicts, concurrent writes and duration rejection passed. Four completion assertions used an obsolete request field. |
| `M1_HTTP_COMPLETION_BINDING.json` | 9/9 passed after binding the verifier to the documented percentage-based completion request. Includes four nearby regression checks. |
| `M1_HTTP_BEHAVIOR.json` | Combined latest observations: 116/116 passed. Five RUN4 completion cases are replaced by targeted observations, with four additional regression cases. This is not one 116-case execution. |
| `M1_HTTP_RESTART.json` + `M1_RESTART_EVENT.json` | 5/5 checkpoint observations passed after the coordinator's recorded graceful API/PostgreSQL restart, including both replicas. |

The observed progress defect was fixed and verified: a position of 1000000 for a
lesson with known finite duration now returns 422, preserving the prior
acknowledged state. The completion binding discrepancy was in the verifier and
operator schema, not a backend defect. `PUT progress` accepts position, optional
percent and optional expected_revision; percent100 sets explicit completion,
lower percent clears it, and resume-point preserves it. completed and
explicit_completed are response fields. The obsolete completed request is
rejected without changing stored progress.

Passing observations cover cookie login, wrong/unknown-password denial, hostile
Origin, absent/wrong CSRF, repeated enrollment, unpublished and unenrolled lesson
denial, private progress/notes, idempotent note retry, other-user DELETE denial,
invalid finite input and bounded bodies, conditional-write conflict, one winning
competing revision update, manual resume/completion, logout with explicit old
cookie replay, suspension, unverified content denial, administrator password/role
checks and the last-admin guard. Session, enrollment, suspension and role
revocation were observed on both API replicas. Private/public catalog and cursor
pages retain authorization and stable lesson identity.

## Coordinated restart checkpoint

Run3 saved acknowledged Bob-only progress/note state. The coordinator then
gracefully stopped both isolated APIs, restarted only the isolated PostgreSQL
container while preserving its durable volume, and launched rebuilt APIs. The
container identity/volume and changed PostgreSQL StartedAt are recorded in
`M1_RESTART_EVENT.json`. Readback on both replicas preserved the acknowledged
percent, position, note ID and content:

```bash
.venv/bin/python scripts/rewrite_verify.py --restart-report docs/rewrite/M1_HTTP_BEHAVIOR_RUN3.json --output docs/rewrite/M1_HTTP_RESTART.json
```

The script does not stop shared services. Its readback alone cannot prove a
restart occurred; operator provenance accompanies it. This proves graceful
restart durability with retained storage, not forced process crash recovery or
failover after primary storage loss.

## Open gates

Production HTTPS cookies, legacy password-hash migration, duplicate completion
credit in aggregate/event accounting, dependency deadlines and overload recovery,
password-hash resource budgets, readiness failure and shutdown/logging require
additional evidence. Forced crash/storage failure remains a separate recovery
gate. Browser/media, M3 feature parity and source-data migration, capacity and
release are independently required. Finite correctness checks do not measure
10,000-learner API capacity, Odysee delivery or AI throughput.
