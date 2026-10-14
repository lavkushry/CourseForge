/** Touch: single tap toggles play/pause; double-tap left/right seeks ±10s. */
export function mountPlayerGestures(
  wrap: HTMLElement,
  video: HTMLVideoElement,
  actions: { togglePlay(): void; seek(position: number): void },
  signal: AbortSignal,
): void {
  let lastTapAt = 0;
  let lastX = 0;

  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' || event.button !== 0) return;
    if (wrap.classList.contains('controls-locked')) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, media-control-bar, input, select, a, [role="slider"]')) return;

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
      actions.togglePlay();
    }, 260);
  };

  wrap.addEventListener('pointerup', onPointerUp, { signal, passive: false });
}
