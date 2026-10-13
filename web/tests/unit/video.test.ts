import { describe, expect, it, vi } from 'vitest';
import { NativeVideoAdapter } from '../../src/player/video';

describe('native precise seek', () => {
  it('uses an exact media timestamp even when the browser exposes approximate fastSeek', () => {
    const element = { duration: 120, currentTime: 0, fastSeek: vi.fn(), preload: '', playsInline: false };
    const adapter = new NativeVideoAdapter(element as unknown as HTMLVideoElement);
    adapter.seek(17.25);
    expect(element.currentTime).toBe(17.25);
    expect(element.fastSeek).not.toHaveBeenCalled();
  });
  it('bounds seek to the current media and ignores non-finite requests', () => {
    const element = { duration: 30, currentTime: 10, preload: '', playsInline: false };
    const adapter = new NativeVideoAdapter(element as unknown as HTMLVideoElement);
    adapter.seek(Number.NaN); expect(element.currentTime).toBe(10);
    adapter.seek(Number.POSITIVE_INFINITY); expect(element.currentTime).toBe(10);
    adapter.seek(-5); expect(element.currentTime).toBe(0);
    adapter.seek(100); expect(element.currentTime).toBe(30);
  });
});
