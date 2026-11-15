/** Touch: tap play/pause, double-tap seek, swipe-up notes; tap video dismisses open study (lease-safe). */
export function mountPlayerGestures(
  wrap: HTMLElement,
  video: HTMLVideoElement,
  actions: {
    togglePlay(): void;
    seek(position: number): void;
    openNotes?: () => void;
    /** Return true when a study sheet was open and is now closed. */
    closeStudy?: () => boolean;
  },
  signal: AbortSignal,
): void {
  let lastTapAt = 0;
  let lastX = 0;
  let swipeStartY = 0;
  let swipeStartX = 0;
  let swipeTracking = false;

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' || event.button !== 0) return;
    if (wrap.classList.contains('controls-locked')) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, media-control-bar, input, select, a, [role="slider"]')) return;
    const rect = wrap.getBoundingClientRect();
    const y = event.clientY - rect.top;
    // Only treat swipes that start in the lower fifth as the tools gesture.
    if (y < rect.height * 0.8) {
      swipeTracking = false;
      return;
    }
    swipeTracking = true;
    swipeStartY = event.clientY;
    swipeStartX = event.clientX;
  };

  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' || event.button !== 0) return;
    if (wrap.classList.contains('controls-locked')) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, media-control-bar, input, select, a, [role="slider"]')) {
      swipeTracking = false;
      return;
    }

    if (swipeTracking) {
      const dy = swipeStartY - event.clientY;
      const dx = Math.abs(event.clientX - swipeStartX);
      swipeTracking = false;
      if (dy > 64 && dy > dx * 1.2) {
        event.preventDefault();
        event.stopPropagation();
        actions.openNotes?.();
        lastTapAt = 0;
        return;
      }
    }

    const now = performance.now();
    const rect = wrap.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const doubleTap = now - lastTapAt < 280 && Math.abs(x - lastX) < rect.width * 0.35;
    if (doubleTap) {
      event.preventDefault();
      event.stopPropagation();
      const delta = x < rect.width / 2 ? -10 : 10;
      actions.seek(Math.max(0, video.currentTime + delta));
      lastTapAt = 0;
      return;
    }
    lastTapAt = now;
    lastX = x;
    window.setTimeout(() => {
      if (lastTapAt !== now) return;
      // Prefer returning to the lesson over toggling play when a sheet is open.
      if (actions.closeStudy?.()) return;
      actions.togglePlay();
    }, 260);
  };

  wrap.addEventListener('pointerdown', onPointerDown, { signal, passive: true });
  wrap.addEventListener('pointerup', onPointerUp, { signal, passive: false });
  wrap.addEventListener(
    'pointercancel',
    () => {
      swipeTracking = false;
    },
    { signal },
  );
}
