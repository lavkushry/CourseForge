# Certificate issuance and public verification contract

This contract is grounded in `app/retention.py` (`check_or_issue_certificate`,
`verify_certificate`), `app/migrations.py` (the certificate table), the certificate
routes and verification HTML in `app/main.py`, `app/auth.py` account deletion and
public-route handling, `app/static/app.js` / `core.js` completion modal,
`app/static/index.html`, and `tests/test_phase4_learning_retention.py`.
It describes this backend slice, not browser parity or capacity evidence.

## Eligibility and snapshots

The course must contain at least one lesson. Every current lesson in that course
must have `progress.completed=true` for the caller and at least one accepted
`quiz_attempts.passed=true` for that caller and lesson. Count distinct lessons,
not attempts. Include all lesson statuses, including queued/unindexed lessons;
missing quiz definitions/attempts never exempt a lesson. A later failed attempt,
changed quiz revision or withdrawn quiz definition does not undo a prior pass.
Retain the learning slice's accepted grading result and threshold (70 percent),
without recalculating answers in the certificate module. Progress completion is
the existing explicit/automatic completion signal, not a new watch-time rule.
Notes, planner checklists, practice, recall self-ratings and labs cannot substitute
for either requirement. Cross-learner and other-course records never contribute.

Issued certificates are immutable snapshots of certificate ID, owner, stable
course ID, course label/title, learner name, verification code, completion instant
and available issuance provenance. Later profile/catalog changes, new lessons,
progress resets or failed quizzes never rewrite or retroactively disqualify an
issued credential. Current access still governs private retrieval and issuance.
New native issuance stores counts and criterion version, without answers,
feedback, private learning content or inferred mastery claims.

The legacy table has no unique owner/course constraint. Preserve every imported
certificate ID/code, including historical duplicate issuances: imported rows may
coexist, and private retrieval deterministically selects earliest completion time
then ID. New native issuance is unique per owner/course, checks for any existing
imported/native snapshot first, and never generates a replacement code for it.
Imported certificates do not need to satisfy today's requirements.

## Authentication, concurrency and commands

Private routes require a currently verified, unsuspended account and live session.
Students require current enrollment in a published course; administrators may
access unpublished courses without enrollment, but can issue only for themselves
and must meet the same completion/quiz requirements. No caller-supplied owner,
name, timestamp, eligibility, certificate ID or verification code is accepted.

Issuance requires same-origin CSRF, JSON body `{}` (16 KiB maximum), and an
`Idempotency-Key` of 1..128 non-whitespace-padded characters. Keys are private
to a learner. Reusing a key for another course returns 409. Store the durable
response and HTTP status: identical retries retain the response even when later
learning state changes. An ineligible command retains its ineligible response;
use a new key after completing requirements. Revalidate account and course access
before every retry response. GET never issues or records a command.

Short SQL transactions lock current identity/access. A learner-scoped advisory
lock serializes command keys; an exclusive course-row lock serializes issuance
and prevents course/lesson additions or accepted progress/quiz writes from racing
the eligibility snapshot through existing access guards. Existing lesson rows are
locked while checking all requirements. Uniqueness is also enforced by PostgreSQL.
No provider, SMTP, model call or stream occurs in the transaction.

## Public API

| Route | Behavior |
| --- | --- |
| GET `/api/v1/courses/{id}/certificate` | 200: existing issued snapshot, otherwise read-only readiness with total/completed/passed/remaining counts; empty course gives `eligible=false`, reason `Course has no lessons` |
| POST `/api/v1/courses/{id}/certificate` | `{}`; 201 newly issued, 200 existing snapshot or ineligible readiness; idempotent status/body retained |
| GET `/api/v1/certificates/verify/{code}` | Public; 200 minimal immutable verification projection, 404 missing/invalid code |
| GET `/verify/{code}` | Public responsive HTML certificate or 404 not-found page; escaped text and Print / Save PDF action |

Issued private responses preserve `issued`, `certificate_id`, `verification_code`,
`student_name`, `course`, `completed_at`, `verify_url` (`/verify/{code}`). Readiness
preserves `eligible`, `total_lessons`, `completed_lessons`, `passed_quizzes`,
`remaining_lessons`, `remaining_quizzes`, and empty-course `reason`, plus `issued`.
Public JSON exposes only `valid`, `student_name`, `course`, `completed_at`,
`verification_code`, `status` (`Verified Official CourseForge Certificate`).
Never expose owner/course IDs, email, session/CSRF tokens, answers, scores,
feedback, eligibility provenance or command records publicly.

Missing private scope returns common structured 404; authentication 401,
verification/CSRF/origin denial 403, malformed JSON 400, missing command key 400,
key mismatch 409, unavailable database 503. Public lookup trims surrounding code
whitespace and remains case-sensitive, as in Python. Accept bounded path-safe
ASCII alphanumeric/underscore/hyphen codes so preserved legacy codes continue
working; never derive a code from an owner ID. New codes use 128 cryptographic
random bits (`CF-` and two 16-hex groups); legacy 64-bit codes remain unchanged.
Verification pages escape names, titles and unknown codes, avoid unsafe template
values, and use no-store, no-referrer, noindex and a restrictive CSP with a nonce
for the static print action. Neither success nor failure pages expose private data.

## Retention and migration

Session revocation, suspension, enrollment removal and course unpublication deny
private access and replay. They do not revoke a previously issued public credential:
the legacy verifier reads immutable snapshots without checking current enrollment
or publication. Account deletion cascades certificates and command responses,
so deleted-account codes return 404. Course deletion leaves historical public
snapshots intact, matching the legacy certificate's non-FK course label; private
scope requires a current course and returns 404. No certificate revocation feature
exists in the legacy slice, and none is implied by enrollment revocation.

Migration 009 supplies `course_certificates`: preserve legacy `id`, `user_id`,
mapped `course_id`, issued `student_name`, original `verification_code` and
`completed_at`; preserve the original course label in `course_title`. Mark rows
`origin='legacy'`, `eligibility=NULL`; do not reissue, invent missing provenance or
apply native eligibility checks. This is a schema/import seam, not an importer or
semantic rehearsal. Check malformed/duplicate codes and missing owners explicitly
before import; never silently drop rows or rotate codes.

## Required evidence and remaining gates

Disposable PostgreSQL plus actual HTTP tests prove readiness without GET writes,
all completion/quiz requirements, any-pass versus latest-failure, distinct lesson
counts, learner isolation, concurrent issuance/retries, command snapshot durability,
current-access/CSRF denials, imported-code preservation, immutable snapshots,
account/course retention, safe public JSON and escaped success/failure HTML.
Root integration, OpenAPI, TypeScript explicit-issuance/completion flow, real browser
print/mobile/accessibility verification and semantic migration/recovery rehearsal
remain separate gates. No learner-capacity claim follows from these tests.
