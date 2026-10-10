# CourseForge learning player

The learning page uses a locally hosted Media Chrome 4.19.3 bundle around the authenticated CourseForge media gateway. Lessons, private notes/bookmarks, and available transcripts share one study panel. Existing course resources, focus timer, AI summary, tutor, and study paths remain accessible through Study tools.

Player controls support play/pause, buffered seeking, ten-second jumps, volume, elapsed/remaining time, speed from 0.5× to 3×, theater mode, and fullscreen with the viewer watermark. On touch screens, double-tap the left or right half of the video to seek. With focus on the player, Space plays/pauses, arrows seek, M mutes, F opens fullscreen, and L locks controls. Controls hide after three seconds of inactivity while playing; paused players and focused controls remain visible.

Control lock keeps playback running while disabling buttons, seek gestures, and player shortcuts. Hold Unlock for one second or activate it with Enter; Escape also unlocks. Leaving or changing a lesson clears lock. Native browser controls remain available if the component bundle fails to load. Picture-in-picture is omitted because it would omit the CourseForge watermark.

Speed, theater mode, and optional autoplay are account preferences. Autoplay is off by default. When enabled, the next available lesson in the current course has a cancelable ten-second countdown. Watched coverage and explicit lesson completion remain separate. Volume/mute preferences are stored on the current device under the account's ID.

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

Browser-reported playback, visible lesson activity, watched coverage, and self-reported completion are distinct measures. They do not establish attention. Heartbeats include actual playback state to repair a missing pause/playing request. Delivery is ordered and bounded: four-second request timeout, at most two attempts using the same sequence, and coalesced waiting heartbeat samples. Lost acknowledgments do not duplicate credit. Reclaiming ownership resets the time baseline; long outages do not invent watch time or overwrite another player's resume point.

Odysee can return `ComponentsNotStartedError` for wallet-backed authorization after its SDK sleeps. CourseForge performs a status check and retries that RPC once. Other provider failures surface a manual recovery action; no repeated automatic player reload occurs. RPC error data and provider signatures are excluded from learner responses and audit records.

The gateway and watermark provide access control and deterrence. They are not encrypted DRM and cannot promise that a viewer cannot copy delivered media or record their screen. Embedded fallback retains ownership and visible activity tracking, with manually saved resume points. Quality choices, caption controls, and scrub thumbnails require real provider feeds and are not fabricated.

## Assets and verification

Run `scripts/build_player_assets.sh` to regenerate the pinned bundle with esbuild 0.25.12. The MIT license is retained in `app/static/vendor/media-chrome-LICENSE.txt`. No runtime JavaScript CDN is required.

Regression checks cover shared native/embed ownership, confirmed takeover, paused ownership, hidden release, duplicate acknowledgments, missed state transitions, long disconnections, access revocation, logout, private preferences, provider startup recovery, delivery bounds, and real browser geometry/control-lock behavior. Browser playback acceptance uses uploaded recordings from both courses, including Azure lecture [005], with decode and seek checks. Viewports include 320, 390, 768, 1024, and 1366 pixels, plus landscape. No demonstration courses or accounts are created on the production server.
