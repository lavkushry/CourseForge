import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EndNavigation } from '../../src/player/navigation';
import { clock } from './fixtures';

describe('autoplay navigation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('never navigates when autoplay is disabled, including a completed lesson', async () => {
    const next = vi.fn();
    const navigator = new EndNavigation(next, vi.fn(), clock);
    navigator.preference(false); navigator.ended(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(next).not.toHaveBeenCalled();
  });
  it('requires an ended event, then waits a cancellable five seconds', async () => {
    const next = vi.fn(); const countdown = vi.fn();
    const navigator = new EndNavigation(next, countdown, clock);
    navigator.preference(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(next).not.toHaveBeenCalled();
    navigator.ended(true);
    await vi.advanceTimersByTimeAsync(4999);
    expect(next).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(next).toHaveBeenCalledOnce();
  });
  it('disabling autoplay during a countdown cancels navigation', async () => {
    const next = vi.fn();
    const navigator = new EndNavigation(next, vi.fn(), clock);
    navigator.preference(true); navigator.ended(true);
    await vi.advanceTimersByTimeAsync(2000);
    navigator.preference(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(next).not.toHaveBeenCalled();
  });
});
