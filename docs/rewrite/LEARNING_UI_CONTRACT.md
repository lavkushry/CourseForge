# TypeScript classroom learning tools contract

Scope: preserve the legacy lesson bookmarks, approved lesson quizzes with private
attempt feedback/history, and private spaced review cards with reveal/grade/history.
This is an isolated-staging implementation, not a production or capacity verdict.
Legacy references: app/static/app.js quiz/review flows, app/study.py,
app/reviews.py, and the Go learning acceptance contract.

- Learning tools are available only after authorized lesson detail loads. Opening a
  new lesson, leaving the classroom or signing out aborts all requests and discards
  the previous learner's private UI. Late responses cannot render into a new lesson.
- Bookmarks have a label and the player timestamp captured at submission. Read more
  uses bounded cursor pages. Save retries retain the same command and timestamp
  after an uncertain network failure; editing the label creates a new command.
  Seeking and owned deletion use the actual API acknowledgement.
- Quizzes load only approved public question projections. No answers or explanations
  are shown before a graded attempt. Every question requires an answer; submissions
  include the exact quiz ID/revision and an idempotency key. An uncertain retry
  preserves the command; stale definitions show a visible error and require reload.
  Private graded feedback and paginated immutable attempt history are displayed,
  with source timestamp seeks only within the current lesson.
- Reviews are filtered to the current course; both due and all-card modes have
  bounded cursor pagination. Private cards can be authored from the lesson with its
  timestamp. Answers stay concealed until Reveal. Grades 0–5 use the current card
  revision and a duplicate-safe command. Success advances the schedule and retains
  its attempt acknowledgement. Explicit Finish review submits only acknowledged
  attempt IDs; a failed completion remains retryable without repeating grades.
  Schedule/history are server responses; browser elapsed time invents no credit.
- All mutations use the existing authenticated API client and CSRF. Errors remain
  visible, control state recovers, and navigation cancels requests. Payload text is
  rendered through DOM text nodes, never interpreted as HTML. No private records
  or answer content are persisted in browser storage or published in evidence.
- Generation/adaptive review/quiz curation remain separate pending features where
  their executors or UI are absent. Manual cards and pending quiz messages do not
  pretend to be model generation. No fake successful attempt or review credit.

Validation: strict TypeScript build; unit validation/command retry tests; browser
bookmark/quiz/review and navigation cancellation tests on synthetic route fixtures;
then a scoped browser flow against real staging Go/PostgreSQL where feasible.
Provider decoding, production lessons, API/media/AI capacity and full application
parity are outside this slice's verdict.

Course lesson navigation also preserves the legacy Learned indicator: a positive
server quiz-status projection or accepted passed attempt supplies the badge. Status
pages are bounded and additional pages have an explicit More learned badges control.
No badge is inferred from video completion or an ungraded form.
