import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api';
import type { Pulse } from '../../src/contracts';
import { ProgressDelivery } from '../../src/player/delivery';
import { acknowledgement, clock, deferred } from './fixtures';

const pulse = (sequence: number): Pulse => ({ sequence, kind: 'heartbeat', position: sequence * 10, playing: true, visible: true, elapsed_seconds: 10, playback_rate: 1 });

describe('ordered durable progress delivery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries a lost acknowledgement with the identical payload before later sequences', async () => {
    const requests: Pulse[] = [];
    const saved = vi.fn();
    const queue = new ProgressDelivery({
      request: async packet => {
        requests.push(packet);
        if (requests.length === 1) throw new ApiError('temporarily unavailable', 503);
        return acknowledgement(packet);
      }, onSaved: saved, onError: vi.fn(), clock,
    });
    const first = queue.send(pulse(1));
    const second = queue.send(pulse(2));
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([first, second]);
    expect(requests.map(request => request.sequence)).toEqual([1, 1, 2]);
    expect(requests[0]).toEqual(requests[1]);
    expect(saved).toHaveBeenCalledTimes(2);
    expect(queue.pending).toBe(0);
    queue.stop();
  });

  it('fails visibly and cancels the outstanding request when the bounded queue fills', async () => {
    const request = deferred<ReturnType<typeof acknowledgement>>();
    const failure = vi.fn();
    let signal: AbortSignal | undefined;
    const queue = new ProgressDelivery({ request: (_packet, incoming) => { signal = incoming; return request.promise; }, onSaved: vi.fn(), onError: failure, maxQueue: 2, clock });
    const outcomes = Promise.allSettled([queue.send(pulse(1)), queue.send(pulse(2)), queue.send(pulse(3))]);
    expect(signal?.aborted).toBe(true);
    expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0]?.[0]).toMatchObject({ code: 'queue_full' });
    expect((await outcomes).every(outcome => outcome.status === 'rejected')).toBe(true);
    request.resolve(acknowledgement(pulse(1)));
  });

  it('does not retry terminal access failures or acknowledge them as saved', async () => {
    const request = vi.fn(async () => { throw new ApiError('access revoked', 403); });
    const saved = vi.fn();
    const failed = vi.fn();
    const queue = new ProgressDelivery({ request, onSaved: saved, onError: failed, clock });
    await expect(queue.send(pulse(1))).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledOnce();
    expect(saved).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledOnce();
  });

  it('bounds retries and honors provider Retry-After without retaining an infinite queue', async () => {
    const request = vi.fn(async () => { throw new ApiError('busy', 429, '', 2000); });
    const failed = vi.fn();
    const queue = new ProgressDelivery({ request, onSaved: vi.fn(), onError: failed, clock, maxAttempts: 3 });
    const outcome = queue.send(pulse(1)).catch(error => error);
    await vi.advanceTimersByTimeAsync(1999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2001);
    await outcome;
    expect(request).toHaveBeenCalledTimes(3);
    expect(queue.active).toBe(false);
    expect(queue.pending).toBe(0);
  });

  it('cancels retries when a lesson is disposed', async () => {
    const request = vi.fn(async () => { throw new Error('network disconnected'); });
    const queue = new ProgressDelivery({ request, onSaved: vi.fn(), onError: vi.fn(), clock });
    const result = queue.send(pulse(1)).catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    queue.stop();
    await result;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(request).toHaveBeenCalledOnce();
  });

  it('rejects malformed acknowledgements before reporting saved credit or ownership', async () => {
    const request = vi.fn(async (packet: Pulse) => ({ ...acknowledgement(packet), coverage: -10 }));
    const saved = vi.fn();
    const failed = vi.fn();
    const queue = new ProgressDelivery({ request, onSaved: saved, onError: failed, clock });
    await queue.send(pulse(1)).catch(() => undefined);
    expect(saved).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(queue.active).toBe(false);
  });
});
