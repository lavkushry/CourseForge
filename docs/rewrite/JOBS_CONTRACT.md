# Durable job behavior contract

This contract defines the M3 queue foundation; it does not certify AI generation,
lab isolation, artifact publication or throughput. Product adapters still need their
own positive/negative result and recovery evidence.

- Submission is bound to an authenticated learner and an authorized lesson. A
  required idempotency key returns the same job for the same kind/lesson/payload;
  reusing it for another command returns a conflict. Private status, payloads and
  results cannot be read or canceled by another learner.
- Payloads/results and lists are bounded. Submission pressure has explicit global
  and per-learner queue limits, shared by replicas. Resource limits govern running
  jobs across workers; an HTTP learner count never defines AI worker capacity.
- A worker claims a durable job with an expiring lease and a monotonically
  increasing attempt/fence. Execution occurs after the claim transaction commits.
  No database connection is held during a model call or sandbox execution.
- An expired worker cannot renew, retry or publish. Reclaim changes the fence;
  death at the attempt limit produces a terminal failure rather than an immortal
  running record. Retrying a failed attempt has a bounded delay/attempt count.
- Completion and its outbox record commit together. The successful fence owns the
  only result. A stale or canceled attempt cannot run a publication transaction.
  Consumers must make external publication idempotent by job/event ID; the outbox
  does not make external side effects exactly once.
- Cancellation fences a running attempt immediately. Revoked account/enrollment
  state prevents result publication. API acknowledgment follows durable commit.
- Browser GET, list and submission-replay responses use `Queue.PublicJob`.
  Private quiz executor results are omitted by default. Namespaced products need
  an explicit pure `ResultProjector`; unknown namespaces fail closed. Paths and
  topic assessments expose only resource references through job status, never
  generated question answers or excerpts. Their resource APIs independently
  recheck current ownership and citations before returning content. Raw results
  remain stored for fenced publication/recovery; internal `Queue.Get` is private.
- Browser job reads/lists require current verified account and lesson/course
  access, including publication/enrollment and administrator-only operation
  boundaries. Losing access hides retained results; it does not delete them.
  Cancellation of an owned job remains available to stop pending work.
- Worker publication dispatch uses payload product namespace and job kind.
  Lesson quiz/review results go to learning; learning-path/topic-assessment
  results go to paths. Unknown namespaces, mismatched kinds and missing product
  publishers reject publication. A path kind without a namespace is invalid.

Tests use disposable PostgreSQL schemas and two independent queue clients to
exercise concurrent claims, limits, retries, cancellation and stale publication.
Large load, real adapters, worker-process death and restart recovery remain later
gates. PostgreSQL documents queue use of `SKIP LOCKED` in its
[SELECT reference](https://www.postgresql.org/docs/18/sql-select.html).
