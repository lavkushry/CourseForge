# CourseForge UI and player acceptance

Added 2026-10-12 to the full rewrite scope. The reference is
[7Movies](https://7movies.ac/), whose featured banner, ranked rows and My List
navigation inform the browsing hierarchy. Use original CourseForge presentation
and course artwork/metadata; visible data must correspond to actual API state.

The user also explicitly requests attention to the currently implemented UI.
Preserve its course, classroom, navigation and learning workflows during the
Go/TypeScript port. Review the existing deployed screens and responsive behavior
alongside the new discovery view; discovery alone is not UI parity.

## Discovery and presentation

- A polished dark visual system with clear typography, generous spacing, consistent
  controls and strong course artwork. Featured course, continue-learning, available
  courses and My List connect to real routes. Avoid fabricated ratings or popularity.
- Course selection opens real metadata, ordered sections/lessons and enrollment.
  Continue-learning uses private saved position. Search and saved-list actions work
  through authorized APIs, with bounded results and visible empty/error states.
- Responsive layouts work at 390, 768, 1366 and 1920 pixels without clipped controls
  or page overflow. Rows support touch and keyboard navigation; essential actions
  remain reachable outside desktop sidebars.
- Keyboard focus, semantic headings/landmarks, form labels, dialogs, reduced motion
  and readable contrast remain explicit. Course imagery uses useful alternate text
  or is marked decorative. UI status reflects actual durable acknowledgments.
- Discovery does not download or autoplay every course's video. Artwork loading is
  bounded/lazy; asynchronous views have cancellation and stale-response protection.

## Player and learning

- Cinematic viewing area, clear playback/volume/seek/speed/fullscreen/theater controls,
  native fallback, captions when available, timestamp notes and course navigation.
  Controls work with pointer, touch and keyboard. Preserve deliberate playback
  takeover and watermark/access ownership.
- Resume/restart, end-only autoplay with cancellable countdown, hidden/offline pause
  and explicit reclaim preserve the existing behavior contract. Moving between
  lessons cannot leak or apply a previous lesson's response/state.
- Reproduce the current lesson-opening failure at the media boundary. Inject
  transient503, stalled/truncated media, expired401 and displaced409 cases. A
  bounded owned retry chain must recover transient delivery to a decoded frame,
  or show a specific useful action after exhaustion. Sign-in recovery stops
  retries; ownership recovery requires deliberate takeover. A permanently closed,
  displaced session returns409 only to its correctly bound, currently authorized
  caller; expired, revoked and other learners' sessions remain denied. Deliberate
  takeover opens a fresh session and never revives its old media token. Fresh-session retry
  releases its old lease and cannot automatically steal another tab's player.
  Leaving or changing lessons aborts preflight, source loading and retry timers.
  Neither Go nor a retry button alone proves Odysee is serving playable bytes.
- An uncertain save retries its identical command/sequence. Show saved state only
  after valid durable acknowledgment; notes, completion and watched coverage remain
  separate. All learners' records stay private.
- Show quality choices only when real renditions exist. Original-only Odysee sources
  remain original-only until a verified rendition pipeline/provider mapping exists.
  No decorative quality menu or loading animation is evidence of adaptive streaming.

## Required evidence

Inspect actual desktop/mobile renders with screenshots. Verify interaction and
decoded frames on Chromium, Firefox and WebKit, including mobile viewports; actual
devices are a separate release gate. Exercise real Go/PostgreSQL/private media
routes as well as deterministic fixtures. Record bundle size and browser timings
separately from API latency, media bandwidth and provider behavior.

Startup/seek/rebuffer/fatal-rate gates, representative network conditions and sample
sizes remain in `../GO_TYPESCRIPT_CAPACITY.md`. A UI screenshot or short browser
sample cannot establish "no buffering" or 10,000-learner production capacity.
