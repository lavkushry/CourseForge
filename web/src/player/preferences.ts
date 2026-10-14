import { isAbort } from '../api';
import type { PlaybackTransport, PlayerPreferences } from '../contracts';
import { browserClock } from './clock';
import type { Clock, Timer } from './clock';

export const defaultPreferences: PlayerPreferences = { autoplay: false, speed: 1 };

export class PreferenceStore {
  private value: PlayerPreferences = { ...defaultPreferences };
  private timer: Timer | undefined;
  private request: AbortController | undefined;
  private generation = 0;
  private running = false;
  private pending = false;

  constructor(
    private readonly transport: PlaybackTransport,
    private readonly changed: (value: PlayerPreferences) => void,
    private readonly failed: (error: Error) => void,
    private readonly clock: Clock = browserClock,
  ) {}

  get current(): PlayerPreferences {
    return { ...this.value };
  }

  initialize(preferences: PlayerPreferences): void {
    this.value = this.validate(preferences);
    this.changed(this.current);
  }

  update(change: Partial<PlayerPreferences>): void {
    this.value = this.validate({ ...this.value, ...change });
    this.changed(this.current);
    this.generation += 1;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.persist();
    }, 300);
  }

  dispose(): void {
    this.generation += 1;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.request?.abort();
    this.pending = false;
  }

  private validate(value: PlayerPreferences): PlayerPreferences {
    return {
      autoplay: value.autoplay === true,
      speed: Number.isFinite(value.speed) && value.speed >= 0.5 && value.speed <= 3 ? value.speed : 1,
    };
  }

  private async persist(): Promise<void> {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    const generation = this.generation;
    const controller = new AbortController();
    this.request = controller;
    try {
      const saved = await this.transport.savePreferences(this.current, controller.signal);
      if (generation === this.generation && !controller.signal.aborted) this.initialize(saved);
    } catch (error) {
      if (generation === this.generation && !isAbort(error))
        this.failed(error instanceof Error ? error : new Error('Preferences could not save.'));
    } finally {
      this.running = false;
      if (this.pending && !controller.signal.aborted) {
        this.pending = false;
        void this.persist();
      }
    }
  }
}
