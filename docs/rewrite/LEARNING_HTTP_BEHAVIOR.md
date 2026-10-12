# Source-blind Learning HTTP behavior report

No current behavioral failures remain in the exercised APIs. The generation-count finding was fixed by the orchestrator and independently rerun on both replicas. Configured202 durable queue acceptance remains blocked because the approved fixture has no indexed sources.

Target: isolated `http://127.0.0.1:18090` and replica18091, Origin `http://127.0.0.1:5173`. Contract: `docs/rewrite/LEARNING_CONTRACT.md`. Only the prewritten contract, generated public OpenAPI documents and HTTP surfaces were inspected. No implementation source, tests, diffs or history were inspected.

Clause totals: 6 pass, 0 fail, 1 blocked, 0 out_of_scope. Probe totals: 164 pass, 0 fail, 1 blocked, 5 out_of_scope.

| Clause | Behavior | Status |
| --- | --- | --- |
| 1 | Authentication, enrollment, CSRF and private ownership | pass |
| 2 | Bookmarks and duplicate-safe commands | pass |
| 3 | Private review cards, grading and schedule revision | pass |
| 4 | Private review session credits and anchored timezone | pass |
| 5 | Administrator quiz curation and private grading | pass |
| 6 | Generation source readiness and input validation | blocked |
| 7 | Fresh client and API replica persistence | pass |

The synthetic course guard passed. Two unique synthetic verified learners were registered and enrollment was varied before ownership probes. All11 exercised learning mutations rejected missing/wrong CSRF and hostile Origin. Guest and unenrolled access, idempotency, ownership, schedule revision, anchored timezone, cursor bounds, true quiz grading and restored approved curation passed. Fresh authentication returned the same six private state surfaces through either replica.

## Resolved finding

Explicit `count: 0` initially returned `sources_pending409` on both generation routes despite public minimum1. After the orchestrator fix, the independent rerun sent -1,0,null and21 to both routes on both API replicas: all16 returned422. Omitted and valid2 counts returned `sources_pending409` in all8 requests, without generated content.

Sanitized reproduction:
1. Authenticate an enrolled synthetic learner on the isolated fixture stack.
2. POST /api/v1/reviews/generate with lesson_id fixture-lesson-1, count 0, a fresh Idempotency-Key and valid Origin/CSRF.
3. As the approved synthetic administrator, POST /api/v1/admin/lessons/fixture-lesson-3/quiz/regenerate with current expected_revision, count 0, fresh key and valid Origin/CSRF.
4. Compare with count 21 on the same routes.

## Limits

Configured generation202 and durable queue acceptance are blocked by the approved fixture having no indexed sources. Crash/restart recovery, full learning parity, learner capacity, media delivery and provider/model throughput are outside the contract scope. Replica state rereads provide separate correctness evidence only. The coordinated API restart used for the affected-clause rerun is not a crash/recovery test.

Private responses were held in memory. Reports contain aggregate counts, request shapes, public fixture names and status codes; they omit credentials, session identifiers, cookies, CSRF tokens, private card text, answers and quiz solutions.

The matching JSON report contains the per-probe clause matrix, aggregate counts and resolved-finding evidence.
