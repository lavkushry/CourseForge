# Learning API behavior acceptance

Exercise only the isolated Go stack at `http://127.0.0.1:18090`, replica18091,
standalone media18094, with Origin `http://127.0.0.1:5173`. Guard first that public
course `fixture-course` exists with synthetic description. Never create accounts
on port8000 or the public Cloudflare hostname. Approved synthetic administrators
are supplied through exact environment variables, never report their credentials.
Register two distinct synthetic learners and enroll only one in fixture-course.
The public versioned OpenAPI file documents request bodies; implementation source
is excluded from independent verification.

1. Protected learning routes reject guests. Mutations reject missing/wrong CSRF
   and hostile Origin. A verified learner without enrollment cannot read or mutate
   fixture-lesson-1 learning records; enrolled learners retain private ownership.
2. Bookmark creation requires Idempotency-Key, position within the known30-second
   lesson and label. Repeating a command returns the same bookmark; changing its
   payload under the same key conflicts. Lists are bounded and ordered. Another
   learner cannot delete it, even after enrolling in the same course. Authorized
   deletion removes it from subsequent reads.
3. Create a private review card with course_id, lesson_id, question, answer and
   source_start within the lesson. Repeating creation is duplicate-safe. Grade
   requires quality0..5, expected_revision and Idempotency-Key. Accepted grading
   advances the schedule/revision; stale revision conflicts, and an exact retry
   returns the original result. Another learner cannot grade or see its history.
4. Complete a review session using private attempt_ids. Exact retries do not
   create multiple credits; another learner cannot claim the original attempts.
   Initialized timezone stays anchored and credit day uses that authoritative
   timezone. Invalid timezone is rejected without mutation.
5. Students cannot curate quizzes. Administrator creates or revises a fixture
   lesson quiz with source positions inside the lesson, questions, answer choices,
   correct_index, explanation and draft/approved/withdrawn status. Public learner
   quiz detail exposes approved questions without solutions. A graded attempt
   requires quiz_id, revision, answers and Idempotency-Key. Scores and feedback are
   private; retry has one attempt/credit, and an obsolete revision conflicts.
   Draft/withdrawn definitions cannot be attempted. Current curation is restored
   to an approved fixture version at completion.
6. Generation requests without indexed sources return sources_pending409 without
   fake generated content. Invalid counts/citations are rejected. Configured
   generation202 denotes durable queuing, not successful model execution.
7. Data can be re-read using a fresh authenticated client and either API replica.
   Report this separately from crash/restart proof. No media/provider/AI throughput
   or full learning parity claim follows from these API correctness cases.

Report every clause as pass, fail, blocked or out_of_scope with aggregate status
counts and sanitized reproduction steps. Never include cookies, CSRF tokens,
authorization/query tokens, passwords, private card content or quiz solutions.
