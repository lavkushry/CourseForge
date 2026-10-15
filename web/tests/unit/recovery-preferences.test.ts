import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerPreferences } from '../../src/contracts';
import { PreferenceStore } from '../../src/player/preferences';
import { PlayerRecovery } from '../../src/player/recovery';
import { clock, deferred, transport } from './fixtures';

describe('bounded recovery and preference delivery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('bounds media reload attempts and stops timers on disposal', async () => {
    const reload = vi.fn(async () => {
      throw new Error('media unavailable');
    });
    const failed = vi.fn();
    const recovery = new PlayerRecovery({ allowed: () => true, reload, onAttempt: vi.fn(), onFailure: failed, clock });
    const running = recovery.recover(new Error('disconnected'));
    await vi.advanceTimersByTimeAsync(7000);
    await running;
    expect(reload).toHaveBeenCalledTimes(3);
    expect(failed).toHaveBeenCalledOnce();
    expect(recovery.busy).toBe(false);
    const second = new PlayerRecovery({ allowed: () => true, reload, onAttempt: vi.fn(), onFailure: failed, clock });
    const pending = second.recover(new Error('disconnected'));
    second.stop();
    await pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it('does not recover while offline, hidden or displaced', async () => {
    const reload = vi.fn();
    const recovery = new PlayerRecovery({
      allowed: () => false,
      reload,
      onAttempt: vi.fn(),
      onFailure: vi.fn(),
      clock,
    });
    await recovery.recover(new Error('offline'));
    expect(reload).not.toHaveBeenCalled();
  });

  it('debounces changes and serializes writes so a stale acknowledgement cannot overwrite current preferences', async () => {
    const server = transport();
    const first = deferred<PlayerPreferences>();
    vi.mocked(server.savePreferences)
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async value => value);
    const store = new PreferenceStore(server, vi.fn(), vi.fn(), clock);
    store.update({ speed: 1.5 });
    await vi.advanceTimersByTimeAsync(300);
    store.update({ speed: 2, autoplay: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(server.savePreferences).toHaveBeenCalledTimes(1);
    first.resolve({ autoplay: false, speed: 1.5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(server.savePreferences).toHaveBeenCalledTimes(2);
    expect(store.current).toEqual({ speed: 2, autoplay: true });
    store.dispose();
  });
});
