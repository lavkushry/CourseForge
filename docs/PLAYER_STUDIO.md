# CourseForge learning player

The learning page uses a locally hosted Media Chrome 4.19.3 bundle around the authenticated CourseForge media gateway. Lessons, private notes/bookmarks, and available transcripts share one study panel. Existing course resources, focus timer, AI summary, tutor, and study paths remain accessible through Study tools.

Player controls support play/pause, buffered seeking, ten-second jumps, volume, elapsed and total time, speed from 0.5× to 3×, theater mode, and fullscreen with the viewer watermark. On touch screens, double-tap the left or right half of the video to seek. With focus on the player, Space plays/pauses, arrows seek, M mutes, F opens fullscreen, and L locks controls. Controls hide after three seconds of inactivity while playing; paused players and focused controls remain visible.

Control lock keeps playback running while disabling buttons, seek gestures, and player shortcuts. Hold Unlock for one second or activate it with Enter; Escape also unlocks. Leaving or changing a lesson clears lock. Native browser controls remain available if the component bundle fails to load. Picture-in-picture is omitted because it would omit the CourseForge watermark.

Speed, theater mode, and optional autoplay are account preferences. Autoplay is off by default. When enabled, the next available lesson in the current course has a cancelable ten-second countdown. Completion has a clear learner control and can be undone. Native playback also completes a lesson when it reaches the end after at least 90% watched coverage. Seeking to the end alone does not complete it. Course percentages count completed lessons; watched coverage remains a separate administrator metric. Volume/mute preferences are stored on the current device under the account's ID.

Lesson links use `#learning/<video_id>`, with optional `t` and `tab` parameters. They support direct loading, timestamp jumps, opening another tab, and browser Back. Opening another player asks for confirmation before moving playback. A visible paused player retains account ownership. Hidden pages pause and release ownership; resuming requires a deliberate action, with another confirmation if someone has taken over.

## Server ownership

Schema migration 4 adds player sessions, one account ownership lease, player preferences, and links for native, embedded, and activity sessions. Existing personal history and cumulative totals are preserved. Players open during the upgrade must reopen their lesson once.

- `POST /api/videos/{video_id}/player-session` creates a six-hour, login-bound player session. Optional `take_over` defaults to false; conflicts include only the account's own previous lecture title and mode.
- `POST /api/player-sessions/{id}/claim` reclaims ownership, with the same explicit takeover rule.
- `POST /api/player-sessions/{id}/heartbeat` renews the 30-second lease. Hidden/closed events release it. Clients send every ten seconds, including while paused.
- Native and embedded issuance endpoints accept `player_session_id`. Legacy direct issuance acquires ownership through the same gate. Reloading native media invalidates the earlier media session; switching to embedded playback closes native media.
- Media requests and ongoing proxy streams check ownership, current login, account status, publication, and enrollment. Connected players stop on lost ownership; already delivered bytes cannot be recalled.
- `GET/PUT /api/me/player-preferences` stores validated speed, autoplay, and theater preferences privately.

All mutations require authenticated, verified users and the existing Origin/CSRF protections. Account suspension, revoked enrollment, expired login, logout, and takeover exclude the player from live reports.

## Tracking and provider recovery

Browser-reported playback, visible lesson activity, watched coverage, and lesson completion are distinct measures. Completion may be recorded manually or automatically after an eligible ended event; the learning event records the automatic basis. They do not establish attention. Heartbeats include actual playback state to repair a missing pause/playing request. Delivery is ordered and bounded: four-second request timeout, at most two attempts using the same sequence, and coalesced waiting heartbeat samples. Lost acknowledgments do not duplicate credit. Reclaiming ownership resets the time baseline; long outages do not invent watch time or overwrite another player's resume point.

Odysee can return `ComponentsNotStartedError` for wallet-backed authorization after its SDK sleeps. CourseForge performs a status check and retries that RPC once. The native player makes at most two automatic media reload attempts, spaced by 0.8 and 2.5 seconds, while online, visible, and still owning playback. A 20-second stalled-load watchdog uses the same recovery budget. Each attempt requests a new authorized native session and preserves the last usable position, volume, mute, and speed. Offline/background players defer recovery; authentication, ownership, and decode failures stop automatic retries. Leaving a lesson cancels pending recovery. Thirty seconds of advancing playback replenishes the budget. Exhaustion displays one manual Retry or alternative-player action. Retry only seeks within healthy media; errored or uninitialized media reopens the lesson. RPC error data and provider signatures are excluded from learner responses and audit records.

The gateway and watermark provide access control and deterrence. They are not encrypted DRM and cannot promise that a viewer cannot copy delivered media or record their screen. Embedded fallback retains ownership and visible activity tracking, with manually saved resume points. Quality choices, caption controls, and scrub thumbnails require real provider feeds and are not fabricated.

## Assets and verification

Run `scripts/build_player_assets.sh` to regenerate the pinned bundle with esbuild 0.25.12. The MIT license is retained in `app/static/vendor/media-chrome-LICENSE.txt`. No runtime JavaScript CDN is required.

Regression checks cover shared native/embed ownership, confirmed takeover, paused ownership, hidden release, duplicate acknowledgments, missed state transitions, long disconnections, access revocation, logout, private preferences, provider startup recovery, delivery bounds, and real browser geometry/control-lock behavior. Browser playback acceptance uses uploaded recordings from both courses, including Azure lecture [005], with decode and seek checks. Viewports include 320, 390, 768, 1024, and 1366 pixels, plus landscape. No demonstration courses or accounts are created on the production server. Regression coverage includes failed-media Retry, bounded/offline/cancelled recovery, speed-menu focus transitions, watched-content completion, seek-to-end exclusion, and completion undo. A real Azure [005] media request was deliberately interrupted and recovered automatically; both course recordings decoded and played in Chromium. The speed menu, control lock, and 320–1366 pixel widths were exercised against that player.

## Learner interface

Playback receipts, watched-coverage percentages, ownership terminology, processing queues, provider names, and local infrastructure instructions are absent from the learning screen. Status messages describe loading, reconnecting, or a simple action to continue. Resume and recovery prompts do not stack. The toolbar uses accessible 44-pixel targets, a speed popover, an elapsed/total clock, and touch transport controls. Completed lessons show a check icon; unavailable lessons say Coming soon and unknown durations are omitted. Original filenames and provider mappings remain unchanged. Account privacy information retains the collection, administrator-access, and retention disclosures in plain language. Detailed telemetry and its limitations remain available in administrator reports.
