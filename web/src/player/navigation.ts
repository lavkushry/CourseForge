import { browserClock } from './clock';
import type { Clock, Timer } from './clock';

// Completion credit does not trigger navigation. Only a real ended event can
// start this countdown, and disabling autoplay cancels it immediately.
/** True once playback crosses the threshold during continuous play, not after it. */
export function crossedPlaybackThreshold(
  previous: number,
  current: number,
  duration: number,
  threshold = 0.98,
): boolean {
  if (!(duration > 0) || !Number.isFinite(previous) || !Number.isFinite(current)) return false;
  const before = previous / duration;
  const after = current / duration;
  return before < threshold && after >= threshold && after < 1;
}

export class EndNavigation {
  private timer: Timer | undefined;
  private generation = 0;
  private enabled = false;

  constructor(
    private readonly navigate: () => void,
    private readonly countdown: (seconds: number | null) => void,
    private readonly clock: Clock = browserClock,
  ) {}

  preference(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancel();
  }

  ended(hasNext: boolean): void {
    this.cancel();
    if (!this.enabled || !hasNext) return;
    const current = this.generation;
    let seconds = 5;
    this.countdown(seconds);
    const tick = () => {
      if (this.generation !== current || !this.enabled) return;
      seconds -= 1;
      if (seconds === 0) {
        this.timer = undefined;
        this.countdown(null);
        this.navigate();
      } else {
        this.countdown(seconds);
        this.timer = this.clock.setTimeout(tick, 1000);
      }
    };
    this.timer = this.clock.setTimeout(tick, 1000);
  }

  cancel(): void {
    this.generation += 1;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.countdown(null);
  }
}
