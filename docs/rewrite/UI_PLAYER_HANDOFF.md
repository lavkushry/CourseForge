# TypeScript discovery and player handoff

Updated 2026-10-12. This is a working staging slice of the full Python/Go/TypeScript
port. The existing Python application remains intact; this slice does not establish
full UI parity or authorize production cutover.

## Implemented behavior

`web/` provides the dark CourseForge discovery and classroom UI. Featured and
available courses, search, private My List, enrollment and continue-learning use
authorized API metadata/state. There are no fabricated ratings, rankings or
renditions. Course covers fall back to a decorative course treatment when absent;
the isolated fixture has no cover assets. Discovery does not preload course video.

The classroom provides ordered/paginated lessons and mobile lesson drawer, native
video with optional Media Chrome enhancement, keyboard seek/play/volume shortcuts,
speed/volume, theater/fullscreen, controls lock, resume/restart, watermark, timestamp
capture, private timestamp notes, explicit completion and lesson materials when
present. Saved-state messages depend on durable validated acknowledgments. Notes,
explicit completion and watched coverage remain separate. Autoplay starts its
cancellable countdown only after ended; disabled autoplay never advances lessons.

Each lesson owns cancellation and generation state. Hidden/offline playback pauses
and relinquishes ownership; returning online/visible never takes it back. A conflict
requires deliberate Move playback here. Takeover opens a fresh session at the
current position and releases the previous session rather than reclaiming a
permanently displaced session. Retry lesson also releases/reopens, with takeover
disabled. Terminal access and ownership actions survive later native play and
visibility events.

The media boundary uses authenticated HEAD preflight to distinguish HTTP failures
from the browser's generic MediaError. Transient startup/transfer failures have
three owned retries; stalled source loading times out. Exhaustion offers Retry
lesson and Return to course; 401 offers Sign in again with no provider retries;
409 offers deliberate takeover. Leaving/changing lessons aborts probes, media
loading and retries. Truncated-byte acceptance requires actual decoded replacement
bytes, allowing the browser's own authorized replacement range rather than forcing
an extra application HEAD.

Both nginx and Vite route `/api/v1/playback/sessions/:id/media` to the configured
media upstream before the generic API route. Vite's older `/media` split alone did
not cover the actual backend-issued media URL; that development routing gap is fixed.

## Verification and evidence

The recovery suite passed 35/35 checks on Chromium, Firefox, WebKit, mobile Chromium
and mobile WebKit. It exercises HEAD 503, GET 503, bounded permanent 503 exhaustion,
media 401, delayed-probe lesson-switch cancellation, truncated bytes and a stalled
24-second transfer. Every successful recovery checks decoded video frames.
[Sanitized results](browser-evidence/ui-player-2026-10-12/recovery-results.json).
After the lifecycle corrections, the relevant exhaustion/401 recovery actions
were rerun across all five profiles: 10/10 passed.
[Final action checks](browser-evidence/ui-player-2026-10-12/recovery-actions-final.json).

Discovery/player fixture verification also passed 60/60 browser checks, including
keyboard navigation and action focus, reduced motion, native controls fallback,
offline ownership, end-only autoplay/countdown cancellation, duplicate-safe note
retry and explicit completion without autoplay.
[UI/player results](browser-evidence/ui-player-2026-10-12/fixture-ui-results.json).

`npm run build` passed (including TypeScript checking); Vitest passed 37/37 tests
across eight files. Two new controller regressions were observed failing before
the fix: hidden lifecycle events overwriting expired sign-in recovery, and
takeover failing to create a fresh session at the sampled position.

The actual Vite configuration passed an isolated upstream routing smoke check:
catalog/pulse reached API, media HEAD/GET reached the separate media upstream and
Range/cookie/CSRF headers were preserved. Certificate HTML `/verify/:code` and
public JSON verification reach the API, with no SPA fallback. The actual nginx
template also passed its syntax/eight-route forwarding and token-log exclusion
smoke after adding the certificate prefix. Actual isolated Go verification misses
through Vite return the same HTML 404/JSON 404 as the API.
[Routing checks](browser-evidence/ui-player-2026-10-12/routing-results.json),
[real certificate routing](browser-evidence/ui-player-2026-10-12/certificate-routing-results.json).

CLI screenshots of actual Go/PostgreSQL catalog rows were captured at
[390](browser-evidence/ui-player-2026-10-12/discovery-390.png),
[768](browser-evidence/ui-player-2026-10-12/discovery-768.png),
[1366](browser-evidence/ui-player-2026-10-12/discovery-1366.png) and
[1920](browser-evidence/ui-player-2026-10-12/discovery-1920.png) pixels.
Actual private classroom captures were also taken at
[390](browser-evidence/ui-player-2026-10-12/classroom-390.png),
[768](browser-evidence/ui-player-2026-10-12/classroom-768.png),
[1366](browser-evidence/ui-player-2026-10-12/classroom-1366.png) and
[1920](browser-evidence/ui-player-2026-10-12/classroom-1920.png) pixels.
Mobile/tablet/desktop renders were inspected alongside the earlier classroom
captures and the preserved current Python public UI capture. The CLI private-media
sample naturally advanced to 11.06 seconds with 337 reported frames and zero drops.

All 25 unique real Go browser cases have passing evidence across the five profiles:
actual sign-in/enrollment/private-media decoding, durable notes/progress/completion,
search/My List persistence, round-trip deliberate takeover with retained position,
offline suspension/explicit resume and actual sign-in revocation recovery. These
requests reach staging API 18090/PostgreSQL and separate authenticated media 18094;
the suite installs no API or media interception.
[Real Go results](browser-evidence/ui-player-2026-10-12/real-go-final-results.json).

The full run passed 23/25; two seeded-account sign-ins hit the preserved per-account
429 limit before the classroom. The affected test now registers its own synthetic
identity, explicitly logs out, then signs in/enrolls through the UI. Its five-profile
rerun passed 5/5; the final report retains source-run provenance and replaces only
that case. The remaining 20 tests already used independent synthetic identities.
All accounts and writes were confined to the isolated rewrite fixture database.

The earlier diagnostic proved
that a displaced old-window pulse returned 403 `playback_denied`, obscuring the
ownership recovery action; the frontend did correctly pause playback.
[Sanitized diagnostic](browser-evidence/ui-player-2026-10-12/ownership-diagnostic.json).
After the backend correction, displaced pulses return 409 `playback_conflict`;
ordinary resume of the closed session also conflicts, and deliberate takeover
opens a fresh session. The round-trip browser checks now pass in every profile.
Revoked/expired/cross-user/ordinary closed access remains terminal; old displaced
media remains denied. Frontend403 handling was not weakened.

The fresh playback observations used actual 640×360 synthetic fixture bytes:

| Browser profile | Total frames | Dropped | Presented | Position at observation | Elapsed to observation |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 65 | 9 | 56 | 2.04s | 2,180ms |
| Mobile Chromium | 66 | 0 | 66 | 2.03s | 2,159ms |
| Firefox | 45 | 7 | 38 | 1.48s | 1,708ms |
| WebKit | 35 | 0 | 35 | 1.15s | 1,702ms |
| Mobile WebKit | 46 | 0 | 46 | 1.53s | 1,924ms |

These are one decoding observation per profile after deliberate play. Total/drop
counts come from `getVideoPlaybackQuality()`; presented frames are their difference.
Elapsed time includes polling until playback advances past one second; it is not a
first-frame latency estimate, p95 measurement or representative-network acceptance.
The artifact set includes each profile's actual rendered decoding screenshot.

Build artifacts: HTML 0.61 kB (gzip 0.36), CSS 23.72 kB (gzip 6.19), main JS 69.79 kB
(gzip 20.68), dynamically loaded Media Chrome 176.20 kB (gzip 41.49). These are build
sizes, not API/media throughput measurements. Browser samples record elapsed
time to the decoding observation separately from API latency; they do not measure
the capacity contract's p95 startup/seek/rebuffer gates.

Raw Playwright traces and failure contexts remain local under `output/playwright/`
and can contain synthetic sign-in/token traffic. Published summaries allow only
test titles/status/duration and explicit decoded-frame/placeholder-route fields;
they omit source snippets, cookies, headers, actual private URLs and arbitrary
error text. Do not publish raw traces as sanitized evidence. The publishable set is
[this manifest](browser-evidence/ui-player-2026-10-12/manifest.json); it contains
only curated JSON summaries and inspected synthetic-fixture screenshots.

## Remaining UI parity work

The existing `app/static/index.html` and Python application include substantially
more workflows than this new interface. Preserve them during the remaining port:

| Existing area | Current TypeScript gap |
| --- | --- |
| Identity/account | Public catalog before sign-in, registration/invitations/reset/verification, account/profile/password/session/deletion and registration-mode flows |
| Discovery/library | Course organization/section grouping, category/status/sort filters, richer title/details, private history/trending and analytics; actual migrated course artwork |
| Classroom/study | Editable note timestamps, bookmarks, brief/smart resume, transcripts/citations, summaries, quizzes/attempt history, embedded-provider capability handling and study workspace tabs |
| Learning | Reviews/cards/scheduling/grading, topic assessments, learning paths and study syllabus, recommendations/adaptive practice, interview/placement flows and certificates |
| Planning/engagement | Daily/weekly planning/preferences/actual-time, focus actions/history/analytics, studio insights, habits/goals/retention and distinct activity metrics |
| AI/jobs/labs | Tutor/history/modes and cited answers, companion, syllabus/content generation, scan/import/index job progress/cancel/retry, lab catalog/tracks/editor/files/submissions/grader feedback |
| Administration | Overview, learners/details/roles/suspension/sessions/enrollments/invitations, course publication/organization/provider/material management, quiz curation, teacher/system/provider insights, audit/reports/exports/deletion |
| Settings/delivery | Light/dark/system themes, accents and learning preferences, service-worker/cache refresh behavior, production packaging and complete route navigation |

This table is the UI integration handoff, not a replacement for the coordinator's
parity inventory/contracts. Backend endpoint presence does not mean the feature is
available in the new UI. Materials/captions are conditional and need populated
fixtures for complete user-flow proof. Real mobile hardware, live Odysee playback,
provider-authorized scale, full UI parity and production migration/recovery gates
remain separate. No zero-buffering, device-certification or 10,000-learner claim follows
from these browser/fixture results; API capacity, media delivery and AI throughput
remain independently scoped.
