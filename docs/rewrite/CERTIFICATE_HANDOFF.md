# Certificate backend handoff

Implemented against [CERTIFICATE_CONTRACT.md](CERTIFICATE_CONTRACT.md), written
before implementation. This is backend correctness evidence only. No shared
staging migration, production mutation, main wiring, OpenAPI or web edit was made
by this slice.

## Integration

```go
import "courseforge/backend/internal/certificates"

certificates.New(pool).Register(server.Mux, auth)
```

Signatures: `New(*pgxpool.Pool) *Service`;
`(*Service).Register(*http.ServeMux, *identity.Service)`.
No adapter, worker, provider, SMTP, browser clock or extra configuration is needed.
The public verification routes intentionally bypass login middleware.

| Route | Body and result |
| --- | --- |
| GET `/api/v1/courses/{id}/certificate` | No body; 200 existing `Certificate` or `Readiness`; never issues |
| POST `/api/v1/courses/{id}/certificate` | Empty JSON object `{}`; mandatory CSRF and `Idempotency-Key`; 201 new `Certificate`, 200 existing `Certificate` or ineligible `Readiness`; retries preserve original status/body |
| GET `/api/v1/certificates/verify/{code}` | Public; 200 `Verification`, 404 structured not-found |
| GET `/verify/{code}` | Public responsive HTML with Print / Save PDF; 404 generic not-found page |

`Certificate` fields: `issued`, `certificate_id`, `verification_code`,
`student_name`, `course` (issued title/legacy label), `completed_at`, `verify_url`.
`Readiness` fields: `issued`, `eligible`, `total_lessons`, `completed_lessons`,
`passed_quizzes`, `remaining_lessons`, `remaining_quizzes`, optional empty-course
`reason`. `Verification` fields: `valid`, `student_name`, `course`, `completed_at`,
`verification_code`, `status`. The public projection has no owner ID, stable course
ID, private answers, scores, provenance, email or account/session data.

GET replaces the legacy mutation-on-read behavior. Browser completion must read
readiness, explicitly POST when eligible, and use the returned immutable name,
course, issue date and link. Reusing an ineligible command key remains ineligible;
use a new key after completing requirements. No caller-supplied issuance data is
accepted. All routes use current account access, and private routes revalidate
course scope even for existing certificates and command retries.

## Schema and importer seam

Migration: `backend/internal/store/migrations/009_certificates.sql`.
New tables: `course_certificates`, `certificate_commands`. A partial unique index
enforces one native issuance per learner/course; legacy duplicate issuance rows
remain individually verifiable. A trigger rejects updates to issuance snapshots.
The learner FK cascades account deletion. Course references deliberately have no
FK, preserving legacy public snapshots after course deletion.

| Legacy column | Destination |
| --- | --- |
| `id` | `course_certificates.id` unchanged |
| `user_id` | `user_id` unchanged; owner must exist |
| `course` | map stable `course_id`; retain original label in `course_title` |
| `student_name` | unchanged issued snapshot |
| `verification_code` | unchanged, case-sensitive capability |
| `completed_at` | preserve timestamp instant |

Set `origin='legacy'`, leave `eligibility=NULL`. New native credentials use
`origin='native'` and record criterion version/counts in `eligibility`. Historical
rows are not requalified against current progress/quizzes. Preserve all duplicate
owner/course rows; private retrieval chooses earliest completion time, then ID.
Codes remain unique. Malformed codes, missing owners and unmappable course IDs
require explicit preflight resolution; never silently rotate or discard codes.
Schema exists; importer execution and semantic rehearsal remain outstanding.

## Validation

Executed 2026-10-12 using `internal/testutil.Postgres` disposable schemas, synthetic
learners/courses, real identity middleware and public progress/quiz HTTP APIs:

```text
CF_TEST_DATABASE_URL=postgres://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite?sslmode=disable go test -race -v ./internal/certificates
PASS
ok courseforge/backend/internal/certificates 20.276s

go vet ./internal/certificates
PASS
```

Ten passed tests:

- `TestReadinessRequiresEveryLessonAndGETNeverIssues`
- `TestAnyPassedAttemptSurvivesLaterFailureAndQuizWithdrawal`
- `TestQuizPassAloneAndOtherLearnersCannotCompleteCourse`
- `TestConcurrentIssuanceAcrossServicesAndDurableRetries`
- `TestIssuedSnapshotSurvivesProfileCurriculumAndProgressChanges`
- `TestCSRFAndInputDenialsDoNotIssue`
- `TestCurrentAccessRevocationAndRetention`
- `TestImportedCodesAndDuplicateSnapshotsRemainVerifiable`
- `TestPublicVerificationIsMinimalAndHTMLEscapesSnapshots`
- `TestIdentityRevocationBetweenAuthenticationAndWriteIsRechecked`

The final test holds the authoritative account row, lets authentication pass and
the write wait, then suspends the account before releasing the lock: issuance
returns 401 and stores no credential. Concurrency runs through separate Service
instances sharing PostgreSQL. Public tests whitelist every JSON field and verify
escaped hostile names/titles, generic hostile-code failure pages, print markup,
nonce/CSP binding and absence of private data. Account deletion removes codes;
enrollment/session/publication changes leave public credentials verifiable.

## Remaining gates

Root must integrate registration/OpenAPI and apply migration only to an approved
isolated stack. TypeScript explicit issuance, completion modal/share behavior,
actual browser print/mobile/accessibility checks, semantic legacy import, duplicate
code anomaly preflight and process/database crash/recovery rehearsal remain
unproven. Broader milestone checks belong to root. This evidence establishes no
API, media, AI or concurrent-learner capacity.
