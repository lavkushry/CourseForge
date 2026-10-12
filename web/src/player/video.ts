import type { Caption } from '../contracts';
import { probeMedia } from './media-probe';
import { isGatewayPath } from '../validation';

export interface VideoSnapshot {
  position: number;
  duration: number;
  rate: number;
  volume: number;
  muted: boolean;
  paused: boolean;
  ended: boolean;
  ready: boolean;
}

export type VideoEvent = 'play' | 'playing' | 'pause' | 'seeking' | 'seeked' | 'ended' | 'waiting' | 'error' | 'ratechange' | 'timeupdate' | 'volumechange';

export interface VideoPort {
  snapshot(): VideoSnapshot;
  load(url: string, position: number, rate: number, captions: Caption[], signal: AbortSignal): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(position: number): void;
  speed(rate: number): void;
  volume(value: number): void;
  mute(muted: boolean): void;
  unload(): void;
  on(event: VideoEvent, callback: () => void, signal: AbortSignal): void;
}

export function sameOriginMediaPath(value: string, origin: string): string {
  const url = new URL(value, origin);
  if (url.origin !== origin || !isGatewayPath(url.pathname) || url.username || url.password) {
    throw new Error('The lesson did not provide an authorized media gateway URL.');
  }
  return `${url.pathname}${url.search}`;
}

export class NativeVideoAdapter implements VideoPort {
  private currentSource = '';

  constructor(private readonly element: HTMLVideoElement) {
    this.element.preload = 'auto';
    this.element.playsInline = true;
  }

  snapshot(): VideoSnapshot {
    return {
      position: Number.isFinite(this.element.currentTime) ? this.element.currentTime : 0,
      duration: Number.isFinite(this.element.duration) ? this.element.duration : 0,
      rate: this.element.playbackRate,
      volume: this.element.volume,
      muted: this.element.muted,
      paused: this.element.paused,
      ended: this.element.ended,
      ready: this.element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA,
    };
  }

  async load(url: string, position: number, rate: number, captions: Caption[], signal: AbortSignal): Promise<void> {
    const source = sameOriginMediaPath(url, location.origin);
    this.currentSource = source;
    this.element.pause();
    await probeMedia(source, signal);
    if (signal.aborted) throw new DOMException('Lesson changed.', 'AbortError');
    this.element.querySelectorAll('track').forEach(track => track.remove());
    for (const caption of captions) {
      const src = new URL(caption.url, location.origin);
      if (src.origin !== location.origin) continue;
      const track = document.createElement('track');
      track.kind = 'subtitles'; track.label = caption.label; track.srclang = caption.language; track.src = src.href;
      this.element.append(track);
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.element.removeEventListener('loadedmetadata', metadata);
        this.element.removeEventListener('canplay', ready);
        this.element.removeEventListener('error', failed);
        signal.removeEventListener('abort', abort);
      };
      const metadata = () => {
        this.element.playbackRate = rate;
        if (position > 0) this.element.currentTime = Math.min(position, Math.max(0, this.element.duration - 0.1));
      };
      const ready = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('The video could not decode or connect. Retry this lesson; your saved progress is safe.')); };
      const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
      const timeout = setTimeout(failed, 20_000);
      this.element.addEventListener('loadedmetadata', metadata);
      this.element.addEventListener('canplay', ready, { once: true });
      this.element.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      this.element.src = source;
      this.element.load();
    });
  }

  play(): Promise<void> { return this.element.play(); }
  pause(): void { this.element.pause(); }

  seek(position: number): void {
    if (Number.isFinite(this.element.duration)) {
      const target = Math.max(0, Math.min(this.element.duration, position));
      if ('fastSeek' in this.element && typeof (this.element as unknown as { fastSeek: (t: number) => void }).fastSeek === 'function') {
        (this.element as unknown as { fastSeek: (t: number) => void }).fastSeek(target);
      } else {
        this.element.currentTime = target;
      }
    }
  }

  speed(rate: number): void { this.element.playbackRate = rate; }
  volume(value: number): void { this.element.volume = Math.min(1, Math.max(0, value)); }
  mute(muted: boolean): void { this.element.muted = muted; }

  unload(): void {
    this.currentSource = '';
    this.element.pause();
    this.element.removeAttribute('src');
    this.element.load();
  }

  on(event: VideoEvent, callback: () => void, signal: AbortSignal): void { this.element.addEventListener(event, callback, { signal }); }

  getBufferHeadway(): number {
    try {
      const b = this.element.buffered;
      if (!b || b.length === 0) return 0;
      const cur = this.element.currentTime;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= cur && b.end(i) >= cur) {
          return b.end(i) - cur;
        }
      }
    } catch { /* safe */ }
    return 0;
  }
}
