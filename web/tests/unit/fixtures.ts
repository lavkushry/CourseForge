import { vi } from 'vitest';
import type { PlaybackSession, PlaybackTransport, Pulse, PulseAck } from '../../src/contracts';
import type { Clock } from '../../src/player/clock';
import type { VideoEvent, VideoPort, VideoSnapshot } from '../../src/player/video';

export const clock: Clock = {
  now: () => Date.now(),
  random: () => 0.5,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer),
};

export function acknowledgement(pulse: Pulse, owner = true): PulseAck {
  return {
    sequence: pulse.sequence,
    position: pulse.position,
    watched_seconds: pulse.elapsed_seconds,
    coverage: 0,
    owner,
    completed: false,
  };
}

export function session(id = 'session-1'): PlaybackSession {
  return {
    id,
    media_url: `/media/v1/sessions/${id}`,
    position: 0,
    sequence: 0,
    preferences: { autoplay: false, speed: 1 },
    owner: true,
  };
}

export function transport(): PlaybackTransport {
  return {
    create: vi.fn(async () => session()),
    pulse: vi.fn(async (_id: string, pulse: Pulse) => acknowledgement(pulse)),
    release: vi.fn(async () => undefined),
    claim: vi.fn(async () => ({ owner: true, position: 0, sequence: 20 })),
    preferences: vi.fn(async () => ({ autoplay: false, speed: 1 })),
    savePreferences: vi.fn(async value => value),
  };
}

export class FakeVideo implements VideoPort {
  value: VideoSnapshot = {
    position: 0,
    duration: 120,
    rate: 1,
    volume: 1,
    muted: false,
    paused: true,
    ended: false,
    ready: true,
  };
  loaded: string[] = [];
  handlers = new Map<VideoEvent, Array<{ callback: () => void; signal: AbortSignal }>>();
  snapshot(): VideoSnapshot {
    return { ...this.value };
  }
  async load(
    url: string,
    position: number,
    rate: number,
    _captions?: unknown,
    _signal?: AbortSignal,
    _options?: unknown,
  ): Promise<void> {
    this.loaded.push(url);
    this.value.position = position;
    this.value.rate = rate;
    this.value.paused = true;
    this.value.ready = true;
  }
  async play(): Promise<void> {
    this.value.paused = false;
    this.event('play');
    if (!this.value.paused) this.event('playing');
  }
  pause(): void {
    const changed = !this.value.paused;
    this.value.paused = true;
    if (changed) this.event('pause');
  }
  seek(position: number): void {
    this.value.position = position;
    this.event('seeking');
    this.event('seeked');
  }
  speed(rate: number): void {
    this.value.rate = rate;
    this.event('ratechange');
  }
  volume(value: number): void {
    this.value.volume = value;
  }
  mute(muted: boolean): void {
    this.value.muted = muted;
  }
  unload(): void {
    this.value.paused = true;
  }
  on(event: VideoEvent, callback: () => void, signal: AbortSignal): void {
    const listeners = this.handlers.get(event) ?? [];
    listeners.push({ callback, signal });
    this.handlers.set(event, listeners);
  }
  event(event: VideoEvent): void {
    for (const handler of this.handlers.get(event) ?? []) if (!handler.signal.aborted) handler.callback();
  }
}

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
