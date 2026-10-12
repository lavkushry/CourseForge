# Standalone curated lab job scope

Preimplementation contract,2026-10-12. Legacy curated labs do not belong to a
lesson. Extend the existing durable queue without inventing a lesson, a second
lease mechanism, or a claimed executable sandbox.

Migration015 will add an optional owned lab-submission reference to jobs and make
lesson scope nullable only when that reference exists and kind/resource are lab.
The composite submission/owner FK cascades with workspace/account deletion. A
lesson job keeps its existing course publication/enrollment policy. Lab jobs bind
the exact owned session, immutable revision/hash/grader payload and submission's
job ID. Public visibility, claim, renewal and completion require that binding and
a currently verified unsuspended owner. Login expiry does not impersonate a worker;
explicit learner reconciliation separately requires a current login.

`Queue.SubmitLab(ctx,tx,principal,key,submissionID,payload)` performs bounded SQL in
the caller's transaction. It rechecks the current principal, immutable input and
owned session, shares existing fleet admission limits, and inserts one job.
Command replay checks kind, owner, scope and exact JSON payload. The labs module
binds the returned job before committing its submission/command transaction.
Calling generic lesson submission with curated-lab scope is rejected. Browser
payloads cannot supply source bytes, a filesystem path, grade or runner receipt.

Claim and renewal use the same SQL authorization predicate as HTTP visibility.
Fenced completion additionally locks the authoritative input binding before
SQL publication. Stale/canceled/deleted-scope jobs cannot publish grades or outbox
events. Worker envelopes for standalone scope use version2 and an explicit
lab_submission_id; version1 lesson envelopes are retained. Public jobs expose only
owned references, never workspace bytes or unverified executor output.

The typed namespace router dispatches curated_lab only to a real injected labs
publisher. With no verified runner receipt adapter, publication rejects and API
submission stays unavailable. The executor flag, verifier and queue are deliberately
unconfigured in staging until runner isolation is proven. Tests may persist
synthetic receipt evidence; that proves fencing/SQL behavior, not sandbox safety.

Required disposable-PG evidence: standalone jobs without lesson IDs, input/owner/
payload forgery denial, exact replay and conflicting key, concurrent shared queue
admission, public learner isolation, claim/renew/current account revocation,
workspace deletion, stale/cancelled completion and atomic publication rollback.
Preserve existing lesson queue tests. Real runner execution, resource cancellation,
practice bridge, migration/recovery and API/media/AI capacity remain separate gates.
