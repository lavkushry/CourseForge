/** Buffered media end at or after currentTime, or 0 when unknown. */
export function bufferedEnd(media: HTMLMediaElement): number {
  try {
    const ranges = media.buffered;
    if (!ranges.length) return 0;
    const cur = media.currentTime;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= cur && ranges.end(i) >= cur) return ranges.end(i);
    }
    return ranges.end(ranges.length - 1);
  } catch {
    return 0;
  }
}
