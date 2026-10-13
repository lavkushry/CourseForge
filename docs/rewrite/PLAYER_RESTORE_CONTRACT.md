# Restore the complete course player

The user reported unmapped courses, missing previous options, and a player below
the expected YouTube/Netflix/Prime experience. This slice restores player controls;
course/provider mapping and the other learning workflows have separate owners.

## Observed gaps before this change

- The fullscreen element contained play/seek/mute/time/captions only. Its speed,
  fullscreen toggle, PiP, theater, timestamp and course lesson buttons were outside
  fullscreen. Its lesson dialog was outside the fullscreen subtree too.
- A single horizontal control bar squeezed the timeline on narrow screens.
- The visible keyboard help promised L forward seek, but the shell locked controls.
- Browser `fastSeek` intentionally allows approximate keyframe seeking even when a
  command supplies an exact note/citation timestamp. Non-finite input was not
  rejected by the adapter.

## Required behavior

1. A full-width timeline sits above the control row at desktop and 390px widths.
   Pointer dragging and keyboard timeline controls seek actual media.
2. Speed, PiP, fullscreen, theater, timestamp capture, lock, and lesson navigation
   remain reachable within the fullscreen element. Unsupported PiP is explicitly
   disabled. No rendition or adaptive quality choices are invented.
3. Every command uses the existing controller and preference transport; no second
   lease, progress stream, or optimistic saved status is introduced.
4. Opening and closing the course dialog works inside fullscreen and returns focus
   to the in-player opener. Keyboard L seeks forward; X locks. Form/button key
   behavior remains native. Existing hidden/offline/takeover behavior stays intact.
5. Desktop click plays/pauses; double click toggles fullscreen without two unwanted
   play commands. Existing touch double-tap seek remains available.
6. Exact seek clamps finite timestamps to the loaded media and ignores non-finite
   requests. Disposal cancels timers and observers; no late command affects a new
   account view.
7. Chromium, Firefox, WebKit and mobile profiles exercise deterministic playable
   media and the controls. Separate real Go/media and real-device gates remain.

## Integration

Import `mountPlayerChrome` from `./player/chrome` in `web/src/main.ts` and call it
immediately after `bindInterface(video, pageScope.signal)`:

```ts
mountPlayerChrome(required<HTMLElement>('#player-wrap'), video,
  { seek: position => controller?.seek(position) }, pageScope.signal);
```

The module imports `chrome.css`; it does not need a shared stylesheet edit. Keep
native browser video controls when the optional Media Chrome asset cannot load.
The new controls do not establish provider availability, zero buffering, course
mapping completeness, or concurrent learner capacity.
