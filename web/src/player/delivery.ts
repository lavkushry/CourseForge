import { ApiError, isAbort } from '../api';
import type { Pulse, PulseAck } from '../contracts';
import { ContractError, parsePulseAck } from '../validation';
import { browserClock, wait } from './clock';
import type { Clock } from './clock';

export type DeliveryStatus = 'saved' | 'saving' | 'retrying' | 'stopped';

interface QueueEntry {
  pulse: Pulse;
  resolve(ack: PulseAck): void;
  reject(error: Error): void;
}

interface DeliveryOptions {
  request(pulse: Pulse, signal: AbortSignal): Promise<PulseAck>;
  onSaved(ack: PulseAck): void;
  onError(error: Error): void;
  onStatus?(status: DeliveryStatus): void;
  clock?: Clock;
  maxQueue?: number;
  maxAttempts?: number;
}

// A lost acknowledgement retries the exact same sequence and payload. There is
// one in-flight request, a bounded queue, and one abort scope for every lesson.
export class ProgressDelivery {
  private readonly queue: QueueEntry[] = [];
  private readonly controller = new AbortController();
  private readonly clock: Clock;
  private running = false;
  private stopped = false;

  constructor(private readonly options: DeliveryOptions) {
    this.clock = options.clock ?? browserClock;
  }

  get pending(): number {
    return this.queue.length;
  }
  get active(): boolean {
    return !this.stopped;
  }

  send(pulse: Pulse): Promise<PulseAck> {
    if (this.stopped) {
      this.stopped = false;
    }
    if (this.queue.length >= (this.options.maxQueue ?? 12)) {
      const error = new ApiError(
        'Progress could not save. Playback is paused; reconnect and resume here.',
        0,
        'queue_full',
      );
      this.fail(error);
      return Promise.reject(error);
    }
    const result = new Promise<PulseAck>((resolve, reject) =>
      this.queue.push({ pulse: { ...pulse }, resolve, reject }),
    );
    this.options.onStatus?.('saving');
    void this.drain();
    return result;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
    for (const entry of this.queue.splice(0))
      entry.reject(new DOMException('Progress delivery cancelled.', 'AbortError'));
    this.options.onStatus?.('stopped');
  }

  private fail(error: Error): void {
    this.stop();
    this.options.onError(error);
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const entry = this.queue[0];
        if (!entry) break;
        let attempts = 0;
        while (!this.stopped) {
          try {
            const ack = parsePulseAck(await this.options.request(entry.pulse, this.controller.signal));
            if (this.stopped) break;
            if (!Number.isSafeInteger(ack.sequence) || ack.sequence < entry.pulse.sequence) {
              throw new ApiError('The server did not acknowledge progress.', 502, 'invalid_ack');
            }
            this.queue.shift();
            this.options.onSaved(ack);
            entry.resolve(ack);
            if (!ack.owner) {
              this.options.onStatus?.('retrying');
            } else {
              this.options.onStatus?.('saved');
            }
            break;
          } catch (cause) {
            if (this.stopped || (isAbort(cause) && this.controller.signal.aborted)) break;
            const error = cause instanceof Error ? cause : new Error('Progress could not save.');
            attempts += 1;
            if (
              error instanceof ContractError ||
              (error instanceof ApiError && error.terminal) ||
              attempts >= (this.options.maxAttempts ?? 5)
            ) {
              this.fail(error);
              break;
            }
            this.options.onStatus?.('retrying');
            const backoff = Math.min(5000, 500 * 2 ** (attempts - 1));
            const retryAfter = error instanceof ApiError ? error.retryAfterMs : 0;
            const delay = Math.min(30_000, Math.max(retryAfter, backoff * (0.8 + this.clock.random() * 0.4)));
            await wait(this.clock, delay, this.controller.signal);
          }
        }
      }
      if (!this.stopped && this.queue.length === 0) this.options.onStatus?.('saved');
    } catch (error) {
      if (!this.stopped && !isAbort(error))
        this.fail(error instanceof Error ? error : new Error('Progress could not save.'));
    } finally {
      this.running = false;
    }
  }
}
