# Job browser privacy and publication integration

Updated 2026-10-12. Only isolated synthetic PostgreSQL data was used.

An HTTP regression reproduced generated answer disclosure through
`GET /api/v1/jobs/{id}` for both topic-assessment and ordinary quiz jobs. The
shared job response boundary now hides raw quiz results by default, and every
job GET/list/submission acknowledgment, including completed idempotent retries,
uses it. Learning submission acknowledgments use the same boundary. Unknown
product namespaces and malformed scopes never inherit raw executor results.
Owned ordinary tutor/review output remains available while lesson access holds.

A second HTTP regression reproduced a tutor-result read after unenrollment.
Job browser reads and lists now recheck current lesson/course access; private
durable queue records remain retained. Tests assert that sanitizing a response
does not destroy private recovery output. Product projection is pure, without
SQL calls while a job-list query holds its connection.

`publication.Router` separates topic assessments from lesson quiz curation using
the immutable payload namespace. Tests exercise both paths, mismatched/unknown
namespaces, missing publishers and propagation of typed publisher rejection.
`cmd/worker` uses the router; `cmd/api` configures the paths projector. Paths
generation remains disabled by default until a real typed executor is configured.

Verification: `go test -race ./internal/jobs ./internal/learning -count=1` with
explicit disposable test schemas passed (jobs20.897s, learning23.721s).
`go test -race ./internal/publication ./cmd/worker` passed (router1.021s;
worker compilation, no command-package test files). These are correctness and
privacy results, not API capacity, real model throughput, worker-process crash
recovery or production migration evidence. Paths/activity are now wired in isolated staging and have their own package
checks plus42 integrated HTTP checks in PRODUCT_STAGING_HTTP.json. Browser
learning work is recorded separately after its handoff.
