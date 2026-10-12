import { ApiError, isAbort } from '../api';
import { browserClock, wait } from './clock';
import type { Clock } from './clock';

interface RecoveryOptions {
  allowed(): boolean;
  reload(signal: AbortSignal): Promise<void>;
  onAttempt(attempt: number): void;
  onFailure(error: Error): void;
  clock?: Clock;
}

export class PlayerRecovery {
  private controller: AbortController | null = null;
  private attempts = 0;
  private advancedSeconds = 0;

  constructor(private readonly options: RecoveryOptions) {}

  get busy(): boolean { return this.controller !== null; }

  healthy(seconds: number): void {
    this.advancedSeconds += Math.max(0, Math.min(2, seconds));
    if (this.advancedSeconds >= 10) { this.attempts = 0; this.advancedSeconds = 0; }
  }

  stop(): void { this.controller?.abort(); this.controller = null; }

  async recover(cause: Error): Promise<void> {
    if (this.controller || !this.options.allowed()) return;
    const controller = new AbortController();
    this.controller = controller;
    this.advancedSeconds = 0;
    try {
      while (!controller.signal.aborted && this.options.allowed() && this.attempts < 3) {
        this.attempts += 1;
        this.options.onAttempt(this.attempts);
        await wait(this.options.clock ?? browserClock, Math.max(1000 * 2 ** (this.attempts - 1), cause instanceof ApiError ? cause.retryAfterMs : 0), controller.signal);
        if (!this.options.allowed()) return;
        try { await this.options.reload(controller.signal); return; }
        catch (error) {
          if (isAbort(error)) return;
          cause = error instanceof Error ? error : cause;
          if (cause instanceof ApiError && cause.terminal) { this.options.onFailure(cause); return; }
        }
      }
      if (!controller.signal.aborted && this.options.allowed()) this.options.onFailure(cause);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
