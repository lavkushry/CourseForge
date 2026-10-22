import { describe, expect, it } from 'vitest';
import { readFocusLink } from '../../src/app/focus-link';
import { crossedPlaybackThreshold } from '../../src/player/navigation';

describe('focus workspace helpers', () => {
  it('reads a classroom deep link and ignores other hashes', () => {
    expect(readFocusLink('#classroom?course=c1&lesson=l2&t=142')).toEqual({
      courseId: 'c1',
      lessonId: 'l2',
      t: 142,
    });
    expect(readFocusLink('#library')).toBeNull();
    expect(readFocusLink('#classroom?course=&lesson=l2')).toBeNull();
  });

  it('arms auto-advance only when playback crosses 98 percent', () => {
    expect(crossedPlaybackThreshold(97, 98.2, 100)).toBe(true);
    expect(crossedPlaybackThreshold(98.2, 99, 100)).toBe(false);
    expect(crossedPlaybackThreshold(10, 99, 100)).toBe(true);
    expect(crossedPlaybackThreshold(99, 20, 100)).toBe(false);
    expect(crossedPlaybackThreshold(0, 10, 0)).toBe(false);
  });
});
