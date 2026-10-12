# Classroom learning UI handoff

Updated 2026-10-12. Isolated staging only; full application parity and production
capacity remain open. Contract was written before implementation in
[LEARNING_UI_CONTRACT.md](LEARNING_UI_CONTRACT.md).

The existing premium classroom now exposes lazy-loaded Bookmarks, Lesson quiz and
Review cards panels. Bookmarks capture the current timestamp once and retain their
command after an uncertain save; listing, more pages, seeking and owned deletion
use real acknowledgements. Approved quizzes conceal answers until grading, require
all answers, preserve quiz revision/idempotency on retry, display private immutable
feedback and attempt history, and support cited timestamp seeks. Course navigation
renders positive server Learned badges with bounded status pagination; a passed
attempt updates the sidebar and drawer immediately.

Reviews support due/all-card pages, manual lesson card creation, concealed answers,
explicit reveal, quality 0–5 with the card revision, private schedule/history, and
explicit Finish review using only acknowledged attempt IDs. Failed grade/completion
responses remain retryable without repeated attempts/credit. Navigating away before
Finish retains grades in server history but does not complete that review session;
this explicit session action differs from the old UI's per-card completion call.
Manual cards are presented as authored cards, not generated content. Generated and
adaptive reviews, admin quiz curation, broader learning dashboard/weak-area UI, and
other product screens remain separate pending work.

All records remain in memory for the active lesson/learner; no private payloads or
answers are stored in localStorage. Navigation and sign-out abort requests and clear
records. Late responses cannot affect a new lesson. Sign-in expiry returns to login;
403/404 erase loaded learning records and show an access message. Text uses DOM text
nodes. The existing player ownership/recovery and discovery paths are preserved.

Changed files are web/src/learning/{contracts,api,view}.ts, web/src/main.ts,
web/src/style.css, web/tests/unit/learning.test.ts, the learning browser fixture and
specs, and the existing generic browser fixture's empty quiz-status route.
web/package.json, web/scripts/dev_staging.mjs, web/playwright.config.ts and web/vite.config.ts add a repeatable
isolated launch and exclude local evidence/report directories from the dev watcher.
No Go sources, backend units, production database, server or Cloudflare routing were
changed by this agent.

Validation at the handoff source state:

- `npm run build` passed strict TypeScript and Vite production build.
- `npm run test`: 44 unit tests passed, including 7 new learning validation/retry cases.
- `npx playwright test learning.spec.ts --reporter=list --output=test-results-learning-final --trace=off`:
  30 tests passed in one final run across Chromium, mobile Chromium, Firefox, WebKit
  and mobile WebKit. They cover bookmark pagination/delete/seek and lost response,
  pre-grade concealment/required answers/private result and one-attempt retry,
  reveal/grade/Finish review lost responses, stale quiz revision, navigation late
  response cancellation, 401 and 403 cleanup, and Learned badges.
- `COURSEFORGE_BROWSER_STACK=synthetic-rewrite npx playwright test learning-live.spec.ts --reporter=list --output=test-results-learning-live --trace=off`:
  5 tests passed in 36.8s, each with 10 scoped behavior checks and account cleanup:
  actual Go bookmarks, curated lesson 3 quiz attempt/history, manual card creation,
  reveal/grade/Finish review, tool revisits and replica 18091 reads. Each profile
  creates/deletes a unique synthetic account. This proves tool navigation and fresh
  HTTP replica reads; it is not a full browser reload, crash, AI or capacity test.
  Test title was clarified after execution to say tool navigation rather than reload.
- `node scripts/verify_vite.mjs`: all 6 existing real dev-proxy routing cases passed,
  including separate media routing, HEAD/Range/cookie/CSRF and public verification.
- `npx playwright test player.spec.ts discovery.spec.ts --reporter=list --output=test-results-learning-regression --trace=off`: all 60 existing fixture
  regressions passed in 6.5 minutes across the five profiles, covering discovery,
  actual synthetic media decoding, autoplay, takeover, note retry and navigation.

Earlier run provenance is retained: one mobile stale-quiz case reset to catalog while
source hot reload occurred; the complete frozen final 30 run passed that case. An
initial actual-Go guard returned 502 because this agent launched Vite without the
staging environment; no accounts were created. The next actual-Go run stopped at
player loading because simulator 18092 had exited; its accounts were deleted. Root
restored the simulator as a persistent staging unit, and the final five-profile run
passed. These failed setup runs are not counted as passing application evidence.

Use `npm run dev:staging` from web for the fixed isolated stack. Its read-only guard
requires API 18090 and media 18094 `/health/ready`, simulator 18092 `/healthz` and
HEAD `/media.mp4`, and the known public synthetic course fixture. It fixes API/media
upstreams to 18090/18094 and binds Vite 5173 to 127.0.0.1. The opt-in synthetic browser profile automatically chooses the same guarded launch.
`npm run dev:staging -- --check`
checks dependencies without starting a browser server or making any writes. Generic
`npm run dev` retains its normal 8080 development default. At this handoff the named
staging launch is running as exec session 62359; parent can preserve it in a staging
user unit when no browser suite is active.

Twelve curated screenshots in web/evidence/learning-ui/ were captured through the
installed Playwright skill against actual Go using one disposable synthetic learner,
then inspected: desktop 1366 and mobile 390 bookmarks, approved unanswered quiz, and
revealed authored review card. Six normal full-shell viewport captures preserve the
header; wheel scrolling and measured bounds confirmed the learning title and tool
actions were below the header. The other six isolate the component. Labels, controls and content wrap without horizontal
overflow. Only the component captures temporarily hide the sticky
site header during capture to avoid its overlay cropping the component top; no app
styles were changed for that treatment. The account was deleted. PNGs and a checksum
manifest are curated; raw CLI logs, cookies, token-bearing traces and failed-run
artifacts are excluded from this handoff. No live Odysee decoding, representative
mobile devices, load envelope or learner-capacity claim follows from this work.
