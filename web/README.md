# CourseForge browser application

This is the new TypeScript player and browser application for the Go rewrite.
The existing Python application is still available in `app/`; this directory does
not change its assets or production routes.

Use Node 22.12 or later in the Node 22 line (the container pins 22.23.3):

```sh
npm ci
COURSEFORGE_API_URL=http://127.0.0.1:18090 npm run dev -- --host 127.0.0.1
```

Configure the isolated Go API's `CF_PUBLIC_ORIGIN` as `http://127.0.0.1:5173`.
The development server forwards `/api` and `/media` to the configured API without
changing Origin, cookies, CSRF, or media access checks. The production container
serves assets and forwards protected requests to `COURSEFORGE_API_UPSTREAM`.
HTTPS termination and the corresponding public origin belong to deployment config.

```sh
npm run build
npm test
npx playwright install chromium firefox webkit
COURSEFORGE_TEST_MEDIA=/path/to/30-second-fixture.mp4 npm run test:browser -- --grep-invert 'isolated Go stack'
COURSEFORGE_API_URL=http://127.0.0.1:18090 COURSEFORGE_BROWSER_STACK=synthetic-rewrite npm run test:browser -- --grep 'isolated Go stack'
```

The contract browser tests require a real decodable MP4 (default
`/tmp/courseforge-rewrite-media/lecture.mp4`) and use a deterministic API/media
simulator. The opt-in stack profile uses the explicitly seeded rewrite development
database and real Go/PostgreSQL/gateway endpoints. It must not point at production.
Run the profiles serially; browser tests share a dev server and artifact directory.
Keep source edits separate from a measurement run so Vite reloads do not invalidate
its results. Mobile viewports are emulation, not real-device validation.

The player keeps each lesson in its own cancellation scope, serializes bounded
progress retries, and retries identical sequences after an uncertain response.
Only valid server acknowledgements report saved progress. Hidden/offline players
pause and release; reconnecting requires a deliberate reclaim. Completion credit
and next-lesson navigation are separate: autoplay waits for an ended event, honors
the preference, and offers a cancellable countdown. Notes retry with the same
idempotency key, and explicit completion uses the current progress revision.

These checks establish behavior. They do not prove 10,000-learner capacity, live
Odysee availability, or complete feature parity. See the rewrite and capacity
contracts in `../docs/` for the remaining release gates.

The discovery view uses real published-course metadata, a featured course,
server-side catalog search, private continue-learning and durable My List routes.
Course artwork comes from same-site authorized cover URLs with original geometric
CSS artwork when a cover is unavailable. No ratings, enrollment totals, fake
courses or quality renditions are invented. Discovery fetches metadata and cover
images; it does not create playback sessions or download lesson media. Search is
bounded to 100 characters, debounced 300ms and cancels previous requests. Catalog
and saved-list pagination request 24 items at a time; lesson pages request 100.

The classroom preserves ordered lesson navigation and section labels, enrollment,
private timestamp notes, materials, explicit completion, resume/restart, keyboard
and touch controls, captions, watermark, deliberate takeover, native-controls
fallback, end-only autoplay and offline/hidden suspension. Pending saved-list
buttons restore keyboard focus after rendering. Reduced-motion preferences remove
card movement and animation. Native iOS video fullscreen is used when element
fullscreen is unavailable; real-device validation is still required.

Lesson startup and reload first perform an abortable authorized HEAD request.
This identifies expired sign-in and provider failures without downloading video
bytes. Transient startup/transfer errors use one owned retry chain with up to three
retries and 1/2/4-second backoff, respecting bounded Retry-After. After exhaustion,
Retry lesson releases the previous session and opens a new one without automatic
takeover. Expired authentication offers Sign in again. Changing lessons cancels
preflight, source loading and retry timers. These controls improve failure recovery;
they cannot make an unavailable upstream provider serve a video.

For separate deployment of the media gateway, configure
`COURSEFORGE_MEDIA_UPSTREAM` in the web container. It defaults to `api:8080`, like
`COURSEFORGE_API_UPSTREAM`; normal API routes continue to use the API upstream.
The specific session-media path and legacy media prefix use the media upstream
with proxy buffering/caches and access/error logging disabled. Validate this routing
with the pinned nginx container and synthetic loopback upstreams:

```sh
npm run build
python3 scripts/verify_nginx.py
```

Current TypeScript coverage is sign-in, discovery/catalog/enrollment, saved list,
continue learning, classroom/player, notes, materials and completion. The legacy
Python UI and its existing uncommitted improvements remain untouched. Registration,
invitations/password recovery forms, administrator tools, assessments, practice,
learning paths, planner/weekly/focus/habits, AI tutor/import and labs still require
complete browser UI integration and parity checks before production cutover.
The corresponding backend routes alone are not frontend parity evidence.
