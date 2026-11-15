# High-concentration lesson player: focus, notes, and materials

**Date:** 2026-11-15  
**Question:** What makes a video lesson player support high learner concentration and easy access to notes/materials on phone and desktop without breaking focus—grounded in CourseForge’s own player contracts/docs and primary external sources?  
**Scope:** Research only; no UI implementation.  
**Location note:** `docs/research/` did not exist; this file starts that convention for cited research notes. Related contracts live under `docs/rewrite/`.

---

## Executive answer

A concentration-friendly CourseForge player keeps the **video stage dominant**, exposes **transport + captions + speed** without chrome noise, puts **notes/materials in a collapsible study surface** (desktop side rail / phone bottom sheet at a medium detent), and preserves **keyboard, touch, fullscreen-subtree, and durable save** contracts already specified for the TypeScript player. External primary sources converge on the same pattern: hide chrome when idle, keep media operable by keyboard with visible focus, provide captions (and transcript when possible), and use non-modal or half-height sheets so study tools do not steal the lesson.

---

## 1. CourseForge contracts (in-repo primary)

### 1.1 What “good player UX” already means

`docs/rewrite/UI_PLAYER_CONTRACT.md` requires:

- A **cinematic viewing area** with clear playback / volume / seek / speed / fullscreen / theater controls, native fallback, **captions when available**, **timestamp notes**, and course navigation; controls must work with pointer, touch, and keyboard.  
- Responsive layouts at **390 / 768 / 1366 / 1920** without clipped controls; essential actions reachable outside desktop sidebars.  
- Explicit **keyboard focus**, landmarks, reduced motion, readable contrast.  
- Resume/restart, **end-only** cancellable autoplay, hidden/offline pause, deliberate reclaim—not background surprises.  
- Notes / completion / watched coverage remain **separate**; show saved state only after durable acknowledgment.

`docs/GO_TYPESCRIPT_REWRITE_PLAN.md` (Player port section) repeats the same surface: speed, volume, seeking, resume/restart, fullscreen/theater, touch and keyboard, captions when present, watermark, **drawer focus**, timestamp capture, native controls fallback, **materials integration**, and responsive layouts. Lesson loads have abort/generation isolation so stale UI cannot hijack attention with wrong state.

`docs/rewrite/UI_PLAYER_HANDOFF.md` documents the staging slice that already ships: ordered lessons, **mobile lesson drawer**, Media Chrome enhancement with native fallback, keyboard shortcuts, speed/volume, theater/fullscreen, **controls lock**, resume/restart, watermark, timestamp capture, private timestamp notes, explicit completion, materials when present. Remaining classroom gaps called out for parity: editable note timestamps, bookmarks, transcripts/citations, study workspace tabs.

`docs/rewrite/PLAYER_RESTORE_CONTRACT.md` is the concentration-critical restore rule set:

1. Full-width timeline above the control row (desktop and 390px).  
2. Speed, PiP, fullscreen, theater, timestamp capture, lock, and lesson navigation **remain reachable inside the fullscreen element**; lesson dialog opens inside fullscreen and **returns focus to the in-player opener**.  
3. Desktop click play/pause; double-click fullscreen without double play; touch double-tap seek preserved.  
4. Exact seek for note/citation timestamps (finite clamp; no `fastSeek` approximation for exact note seeks).

These clauses are the repo’s own definition of “don’t break focus when studying in fullscreen.”

### 1.2 Study rail / focus workspace shape

`web/src/app/shell.ts` mounts `#classroom` as `focus-workspace drawer-collapsed dock-collapsed` with:

- **Lessons** / **Study** / **Notes** / **Files** header toggles (curriculum vs study tools).  
- Player wrap keyboard affordances documented in `aria-label` (Space/K, J/L, brackets, M, B, F, C, P, Shift+N/P, ⌘B).  
- Media Chrome bar with play, ±10s seek, mute/volume, time, timeline, **captions button**; `autohide="3"`.  
- `#focus-dock` for transcript/notes/resources; `#study-rail` aside for curriculum + study panels.  
- Timestamp note form and Capture / Save Note pills below the stage—not overlaid on the video.

`web/src/player/study-rail.ts` defines tabs: `lessons | brief | materials | quiz | notes | transcript | tutor`. Notes are **timestamped**, seekable back into the lesson, and cleared on lesson change. Materials panel lists files and reports caption tracks attached to the lesson (player captions remain separate from the searchable transcript rail).

`web/src/styles/pages/apple-craft.css` encodes the phone concentration layout (≤768px):

- Hide primary bottom nav while classroom focus-workspace is open (“full screen for the lesson”).  
- Compact 44px heading; **44×44px** transport and focus buttons (thumb zone).  
- Study rail becomes a **fixed bottom sheet** (~62dvh / 520px max), rounded top, grabber pseudo-element, collapsed via `.drawer-collapsed`.  
- Focus dock also sheets from the bottom when open.

`web/src/player/gestures.ts`: single tap play/pause; double-tap left/right ±10s; ignored when controls locked or when hitting chrome—matches Apple’s “tap center to play/pause while chrome is hidden” direction (see §2.3).

`web/src/player/chrome.ts`: `fullscreenelement` set to the player wrap so chrome lives in the fullscreen subtree; theater + lock; settings popover returns focus to opener; L seeks, X locks per restore contract.

**Gap vs contracts:** no `navigator.mediaSession` usage was found under `web/src/` (grep, 2026-11-15). Platform lock-screen / headset control is therefore not yet wired.

---

## 2. External primary sources

### 2.1 W3C / WAI media accessibility

| Claim | Source |
| --- | --- |
| Captions required for prerecorded synchronized media (Level A); captions include dialogue **and** non-speech audio needed to understand content; captions should not obscure relevant video. | [WCAG 2.2 SC 1.2.2 Captions (Prerecorded)](https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded) |
| Provide audio description **or** a full text alternative for time-based media (Level A); transcripts/descriptive text support people who cannot use the visuals. | [WCAG 2.2 SC 1.2.3](https://www.w3.org/WAI/WCAG22/Understanding/audio-description-or-media-alternative-prerecorded) |
| Accessible media needs captions, description, transcripts, and a **player that supports accessibility**. | [WAI: Making Audio and Video Media Accessible](https://www.w3.org/WAI/media/av/) |
| Players must support keyboard operation, **visible focus**, clear labels, sufficient contrast; desirable extras: **playback speed**, caption styling, screen-reader-readable captions, **interactive transcripts** (select text → seek). | [WAI: Media Players](https://www.w3.org/WAI/media/av/player/) |
| All player functionality keyboard-operable ([IC-1]); rich native controls including play/pause, fullscreen, volume, captions on/off, playback rate, structural next/prev ([IC-2]); users must be able to keep controls on screen ([IC-4]); autoplay must be stoppable ([IC-6]). Cognitive guidance: reduce distraction. | [W3C Media Accessibility User Requirements](https://www.w3.org/TR/media-accessibility-reqs/) (Note, 2015) |
| Moving/auto-updating content presented in parallel must be pausable/stoppable/hideable—directly relevant to autoplay-next, countdown cards, and animated chrome. | [WCAG 2.2 SC 2.2.2 Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide) |
| Keyboard interface for all functionality (except path-dependent drawing). | [WCAG 2.2 SC 2.1.1 Keyboard](https://www.w3.org/WAI/WCAG22/Understanding/keyboard) |
| Keyboard focus indicator must be visible. | [WCAG 2.2 SC 2.4.7 Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible) |
| Content reflows at ~320 CSS px without 2D scroll; **video** may need 2D layout, but surrounding notes/UI should still reflow. | [WCAG 2.2 SC 1.4.10 Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow) |

**Concentration reading of WAI:** distraction control (2.2.2), calm chrome, captions/transcript for comprehension without rewatching, and interactive transcript/notes that seek without leaving the player.

### 2.2 MDN / web platform media APIs

| Claim | Source |
| --- | --- |
| Media Session lets the page supply metadata and handlers for play/pause/seek/next/previous so learners control playback from lock screen, headset, and OS media UI **without reopening the lesson page**—preserving flow when attention leaves the tab briefly. | [MDN: Media Session API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API) |
| Fullscreen presents a chosen element and descendants full-screen; entry requires **transient user activation**; choose the element that contains needed controls. | [MDN: Fullscreen API](https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API) |

CourseForge’s restore contract already mandates fullscreen on `#player-wrap` (not bare `<video>`), aligning with MDN’s element-descendant model so notes openers and lesson dialogs can live inside the fullscreen tree.

### 2.3 Apple HIG / Apple developer primary (playback + sheets)

Apple’s HIG “Playing video” and “Sheets” pages are JS-rendered and did not return body text via fetch; the following use first-party Apple developer materials:

| Claim | Source |
| --- | --- |
| Standard video controls **auto-hide during playback**; avoid persistent extra layers over full-screen video; show controls on user request (e.g. tap), then remove them when the user stops interacting. | [Energy Efficiency Guide: Restrict UI When Playing Full-Screen Video](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/EnergyGuide-iOS/HideControlsInFullScreenVideo.html) |
| Tap center to play/pause even while controls are hidden; scrubbing can drop secondary UI so **focus stays on content**. | [WWDC22: Create a great video playback experience](https://developer.apple.com/videos/play/wwdc2022/10147/) |
| Sheets use **detents** (medium ≈ half height, large = full); medium + undimmed detent enables **non-modal** interaction with content behind the sheet; grabber when resizability is unclear; scrolling need not expand the sheet if the primary content (here: video) must stay visible. | [WWDC21: Customize and resize sheets in UIKit](https://developer.apple.com/videos/play/wwdc2021/10063/) |
| Official HIG entry points (cite for product alignment even when body is client-rendered): [Playing video](https://developer.apple.com/design/human-interface-guidelines/playing-video), [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets). | Apple Developer Documentation |

**Concentration reading of Apple:** idle chrome off; transport always reachable by tap/gesture; notes/materials as a **medium, preferably undimmed** sheet so the lesson remains visible and interactive.

---

## 3. Synthesis: principles that preserve focus

Mapped to CourseForge’s vanilla-TS player:

1. **Stage first** — Theater / focus-workspace / hide app chrome on phone while watching (`apple-craft.css`). Matches Apple auto-hide and WCAG pause/distraction intent.  
2. **Chrome on demand** — Media Chrome `autohide`, lock control, fullscreen wrap containing controls (`chrome.ts`, restore contract).  
3. **Study tools as sheets, not overlays** — Desktop study rail beside video; phone bottom sheet ~medium detent; curriculum and dock collapsed by default (`shell.ts`, CSS). Aligns with Apple sheet detents + non-modal medium.  
4. **Timestamped notes ↔ exact seek** — Capture at current time; seek from note list; exact seek contract for citations (`study-rail.ts`, restore contract). Supports “glance at notes without losing place.”  
5. **Captions in player; transcript/materials in dock** — Captions button in control bar; materials panel discloses tracks; interactive transcript is an explicit WAI player capability and a handoff parity gap.  
6. **Input parity** — Keyboard SC 2.1.1 / focus visible 2.4.7; touch gestures; 44px targets on phone; shortcuts help.  
7. **No surprise advance** — End-only cancellable autoplay (UI contract + handoff); cancel control satisfies 2.2.2 for parallel countdown UI.  
8. **Platform continuity** — Media Session (MDN) would keep play/pause/seek available outside the page; currently unimplemented.  
9. **Durable privacy** — Saved notes only after acknowledgment; learner isolation (UI contract)—reduces anxiety that breaks focus (“did that note save?”).

---

## 4. Actionable checklist (CourseForge vanilla-TS player)

Do **not** treat this as an implementation task list already executed—research recommendations only.

### Top 5 actions

1. **Keep fullscreen + in-player study openers intact** — Enforce `PLAYER_RESTORE_CONTRACT`: all transport, timestamp capture, lesson dialog, and focus return stay inside `#player-wrap` fullscreen so notes/materials never force exit from concentration mode.  
2. **Phone study rail = undimmed medium sheet** — Preserve collapsed-by-default bottom sheet (~half viewport), grabber, and video still visible/tappable behind a medium detent; avoid full-screen modal notes that cover the lesson (Apple WWDC21 sheet model + current `apple-craft.css`).  
3. **Ship captions + interactive transcript path** — Caption tracks in the player when present (WCAG 1.2.2 / WAI players); wire transcript rail seek-on-select (WAI interactive transcript) without fabricating text when empty (existing `study-rail` empty states).  
4. **Wire Media Session to the controller** — `navigator.mediaSession` metadata + play/pause/seek/next/previous handlers delegated to existing ownership-aware controller (MDN); never reclaim a displaced lease from a lock-screen action without the deliberate takeover UX.  
5. **Protect concentration chrome** — Auto-hide controls (already `autohide="3"`), honor reduced motion, keep end-only cancellable Up Next, 44px thumb targets, and visible `:focus-visible` on player/study controls (WCAG 2.2.2, 2.4.7; Apple hide-when-idle).

### Additional follow-ons

- Exact seek for note timestamps (restore contract)—do not use approximate `fastSeek` for citation jumps.  
- Materials downloads and caption disclosure remain lesson-scoped; clear on lesson change (already in `StudyRail.updateContext`).  
- Prefer native fallback if Media Chrome fails (handoff)—accessibility of transport must not depend on the enhancement bundle.  
- Evidence gates stay at 390/768/1366/1920 with real keyboard + touch paths (`UI_PLAYER_CONTRACT`).

---

## Sources index

### In-repo

- `docs/rewrite/UI_PLAYER_CONTRACT.md`  
- `docs/rewrite/UI_PLAYER_HANDOFF.md`  
- `docs/rewrite/PLAYER_RESTORE_CONTRACT.md`  
- `docs/GO_TYPESCRIPT_REWRITE_PLAN.md` (§ Player port and media requirements)  
- `web/src/player/{chrome,study-rail,gestures}.ts`  
- `web/src/app/shell.ts` (classroom markup)  
- `web/src/styles/pages/apple-craft.css` (phone watch mode / study sheet)

### External primary

- [WCAG 2.2 Understanding: Captions (Prerecorded)](https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded)  
- [WCAG 2.2 Understanding: Audio Description or Media Alternative](https://www.w3.org/WAI/WCAG22/Understanding/audio-description-or-media-alternative-prerecorded)  
- [WCAG 2.2 Understanding: Keyboard](https://www.w3.org/WAI/WCAG22/Understanding/keyboard)  
- [WCAG 2.2 Understanding: Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible)  
- [WCAG 2.2 Understanding: Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide)  
- [WCAG 2.2 Understanding: Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow)  
- [WAI Making Audio and Video Media Accessible](https://www.w3.org/WAI/media/av/)  
- [WAI Media Players](https://www.w3.org/WAI/media/av/player/)  
- [W3C Media Accessibility User Requirements](https://www.w3.org/TR/media-accessibility-reqs/)  
- [MDN Media Session API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API)  
- [MDN Fullscreen API](https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API)  
- [Apple Energy Guide: Restrict UI When Playing Full-Screen Video](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/EnergyGuide-iOS/HideControlsInFullScreenVideo.html)  
- [WWDC22 Create a great video playback experience](https://developer.apple.com/videos/play/wwdc2022/10147/)  
- [WWDC21 Customize and resize sheets in UIKit](https://developer.apple.com/videos/play/wwdc2021/10063/)  
- [Apple HIG Playing video](https://developer.apple.com/design/human-interface-guidelines/playing-video)  
- [Apple HIG Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)
