export interface PlayerTelemetrySample {
  session_id: string;
  startup_ms: number;
  rebuffer_ms: number;
  play_ms: number;
  errors: number;
  bitrate_switches: number;
}

export interface TelemetryTransport {
  post(sample: PlayerTelemetrySample, signal?: AbortSignal): Promise<void>;
}

/** Collects QoE counters for one playback session and flushes a small payload. */
export class PlayerTelemetry {
  private sessionId = '';
  private openAt = 0;
  private startedAt = 0;
  private playAccum = 0;
  private playStartedAt = 0;
  private rebufferAccum = 0;
  private waitingAt = 0;
  private errors = 0;
  private bitrateSwitches = 0;
  private flushed = false;

  constructor(private readonly transport: TelemetryTransport) {}

  open(sessionId: string): void {
    this.reset();
    this.sessionId = sessionId;
    this.openAt = performance.now();
  }

  markReady(): void {
    if (!this.startedAt && this.openAt) {
      this.startedAt = performance.now();
    }
  }

  markPlaying(): void {
    this.markReady();
    if (!this.playStartedAt) this.playStartedAt = performance.now();
    if (this.waitingAt) {
      this.rebufferAccum += performance.now() - this.waitingAt;
      this.waitingAt = 0;
    }
  }

  markWaiting(): void {
    if (this.playStartedAt && !this.waitingAt) this.waitingAt = performance.now();
  }

  markPaused(): void {
    if (this.playStartedAt) {
      this.playAccum += performance.now() - this.playStartedAt;
      this.playStartedAt = 0;
    }
    this.waitingAt = 0;
  }

  markError(): void {
    this.errors += 1;
  }

  markBitrateSwitch(): void {
    this.bitrateSwitches += 1;
  }

  sample(): PlayerTelemetrySample {
    let play = this.playAccum;
    if (this.playStartedAt) play += performance.now() - this.playStartedAt;
    let rebuffer = this.rebufferAccum;
    if (this.waitingAt) rebuffer += performance.now() - this.waitingAt;
    const startup = this.startedAt && this.openAt ? Math.max(0, Math.round(this.startedAt - this.openAt)) : 0;
    return {
      session_id: this.sessionId,
      startup_ms: startup,
      rebuffer_ms: Math.max(0, Math.round(rebuffer)),
      play_ms: Math.max(0, Math.round(play)),
      errors: this.errors,
      bitrate_switches: this.bitrateSwitches,
    };
  }

  async flush(signal?: AbortSignal): Promise<void> {
    if (this.flushed || !this.sessionId) return;
    this.flushed = true;
    this.markPaused();
    const body = this.sample();
    try {
      await this.transport.post(body, signal);
    } catch {
      // Telemetry must never block teardown or learning progress.
    }
  }

  private reset(): void {
    this.sessionId = '';
    this.openAt = 0;
    this.startedAt = 0;
    this.playAccum = 0;
    this.playStartedAt = 0;
    this.rebufferAccum = 0;
    this.waitingAt = 0;
    this.errors = 0;
    this.bitrateSwitches = 0;
    this.flushed = false;
  }
}

export function validateTelemetryClient(sample: PlayerTelemetrySample): boolean {
  if (!sample.session_id || sample.session_id.length > 200) return false;
  if (!Number.isFinite(sample.startup_ms) || sample.startup_ms < 0 || sample.startup_ms >= 600_000) return false;
  if (!Number.isFinite(sample.rebuffer_ms) || sample.rebuffer_ms < 0 || sample.rebuffer_ms >= 3_600_000) return false;
  if (!Number.isFinite(sample.play_ms) || sample.play_ms < 0 || sample.play_ms >= 86_400_000) return false;
  if (!Number.isSafeInteger(sample.errors) || sample.errors < 0 || sample.errors >= 10_000) return false;
  if (
    !Number.isSafeInteger(sample.bitrate_switches) ||
    sample.bitrate_switches < 0 ||
    sample.bitrate_switches >= 100_000
  ) {
    return false;
  }
  return true;
}
