import type { Caption } from '../contracts';
import { bufferedEnd } from './media-buffer';
import { probeMedia } from './media-probe';
import type { HlsEngine, QualityLevel, StallDiagnostics } from './hls-engine';
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

export type VideoEvent =
  | 'play'
  | 'playing'
  | 'pause'
  | 'seeking'
  | 'seeked'
  | 'ended'
  | 'waiting'
  | 'error'
  | 'ratechange'
  | 'timeupdate'
  | 'volumechange';

export interface LoadMediaOptions {
  hlsUrl?: string;
  posterUrl?: string;
  onLevels?: (levels: QualityLevel[]) => void;
  onStall?: (diagnostics: StallDiagnostics) => void;
  onFatalHls?: () => void;
  onBitrateSwitch?: () => void;
}

export interface VideoPort {
  snapshot(): VideoSnapshot;
  load(
    url: string,
    position: number,
    rate: number,
    captions: Caption[],
    signal: AbortSignal,
    options?: LoadMediaOptions,
  ): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(position: number): void;
  speed(rate: number): void;
  volume(value: number): void;
  mute(muted: boolean): void;
  unload(): void;
  on(event: VideoEvent, callback: () => void, signal: AbortSignal): void;
  setQuality?(levelIndex: number | 'auto'): void;
  getLevels?(): QualityLevel[];
}

export function sameOriginMediaPath(value: string, origin: string): string {
  const url = new URL(value, origin);
  if (url.origin !== origin || !isGatewayPath(url.pathname) || url.username || url.password) {
    throw new Error('The lesson did not provide an authorized media gateway URL.');
  }
  return `${url.pathname}${url.search}`;
}

export class NativeVideoAdapter implements VideoPort {
  private hls: HlsEngine | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  private stallBound = false;
  private levels: QualityLevel[] = [];
  private loadOptions: LoadMediaOptions | undefined;

  constructor(private readonly element: HTMLVideoElement) {
    this.element.preload = 'metadata';
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

  setQuality(levelIndex: number | 'auto'): void {
    this.hls?.setQuality(levelIndex);
  }

  getLevels(): QualityLevel[] {
    return this.hls?.getLevels() ?? this.levels;
  }

  async load(
    url: string,
    position: number,
    rate: number,
    captions: Caption[],
    signal: AbortSignal,
    options?: LoadMediaOptions,
  ): Promise<void> {
    const progressive = sameOriginMediaPath(url, location.origin);
    this.loadOptions = options;
    this.destroyHls();
    this.element.pause();
    this.element.preload = 'metadata';
    if (options?.posterUrl) {
      try {
        this.element.poster = sameOriginMediaPath(options.posterUrl, location.origin);
      } catch {
        this.element.removeAttribute('poster');
      }
    } else {
      this.element.removeAttribute('poster');
    }
    this.applyCaptions(captions);

    const hlsUrl = options?.hlsUrl ? sameOriginMediaPath(options.hlsUrl, location.origin) : '';
    if (hlsUrl) {
      try {
        await this.loadHls(hlsUrl, progressive, position, rate, signal);
        return;
      } catch (err) {
        if (signal.aborted) throw err;
        this.destroyHls();
        options?.onFatalHls?.();
      }
    }
    await this.loadProgressive(progressive, position, rate, signal);
  }

  private applyCaptions(captions: Caption[]): void {
    this.element.querySelectorAll('track').forEach(track => track.remove());
    for (const caption of captions) {
      const src = new URL(caption.url, location.origin);
      if (src.origin !== location.origin) continue;
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = caption.label;
      track.srclang = caption.language;
      track.src = src.href;
      this.element.append(track);
    }
  }

  private async loadHls(
    hlsUrl: string,
    progressive: string,
    position: number,
    rate: number,
    signal: AbortSignal,
  ): Promise<void> {
    // Keep hls-engine (and hls.js) out of the main chunk until adaptive playback is needed.
    const { createHlsEngine, nativeHlsSupported } = await import('./hls-engine');
    if (nativeHlsSupported(this.element)) {
      await this.prepareSource(hlsUrl, position, rate, signal, { assignSrc: true });
      return;
    }
    this.hls = await createHlsEngine({
      onLevels: levels => {
        this.levels = levels;
        this.loadOptions?.onLevels?.(levels);
      },
      onStall: diagnostics => this.loadOptions?.onStall?.(diagnostics),
      onBitrateSwitch: () => this.loadOptions?.onBitrateSwitch?.(),
      onError: (_message, fatal) => {
        if (fatal) {
          this.loadOptions?.onFatalHls?.();
          void this.loadProgressive(progressive, this.element.currentTime || position, rate, signal).catch(
            () => undefined,
          );
        }
      },
    });
    await this.hls.attach(this.element, hlsUrl, signal);
    await this.prepareSource(hlsUrl, position, rate, signal, { assignSrc: false });
  }

  private async loadProgressive(source: string, position: number, rate: number, signal: AbortSignal): Promise<void> {
    await probeMedia(source, signal);
    if (signal.aborted) throw new DOMException('Lesson changed.', 'AbortError');
    await this.prepareSource(source, position, rate, signal, { assignSrc: true });
  }

  private prepareSource(
    source: string,
    position: number,
    rate: number,
    signal: AbortSignal,
    opts: { assignSrc: boolean },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.element.removeEventListener('loadedmetadata', onMetadata);
        this.element.removeEventListener('canplay', onReady);
        this.element.removeEventListener('error', onFailed);
        signal.removeEventListener('abort', onAbort);
      };
      const onMetadata = () => {
        this.element.playbackRate = rate;
        if (position > 0 && Number.isFinite(this.element.duration)) {
          this.element.currentTime = Math.min(position, Math.max(0, this.element.duration - 0.1));
        }
      };
      const onReady = () => {
        cleanup();
        this.watchStalls();
        resolve();
      };
      const onFailed = () => {
        cleanup();
        reject(
          new Error(
            opts.assignSrc
              ? 'The video could not decode or connect. Retry this lesson; your saved progress is safe.'
              : 'Adaptive stream failed to start.',
          ),
        );
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      const timeout = setTimeout(onFailed, 20_000);
      this.element.addEventListener('loadedmetadata', onMetadata);
      this.element.addEventListener('canplay', onReady, { once: true });
      this.element.addEventListener('error', onFailed, { once: true });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      if (opts.assignSrc) {
        this.element.src = source;
        this.element.load();
        return;
      }
      if (this.element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        onMetadata();
        onReady();
      }
    });
  }

  private watchStalls(): void {
    if (this.stallBound) return;
    this.stallBound = true;
    const onWaiting = () => {
      clearTimeout(this.stallTimer);
      this.stallTimer = setTimeout(() => {
        if (this.element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !this.element.paused) return;
        this.loadOptions?.onStall?.({
          currentTime: this.element.currentTime,
          bufferedEnd: bufferedEnd(this.element),
          readyState: this.element.readyState,
          networkState: this.element.networkState,
          at: Date.now(),
        });
      }, 2500);
    };
    const onPlaying = () => {
      clearTimeout(this.stallTimer);
    };
    this.element.addEventListener('waiting', onWaiting);
    this.element.addEventListener('playing', onPlaying);
    this.element.addEventListener('canplay', onPlaying);
  }

  async play(): Promise<void> {
    try {
      await this.element.play();
    } catch (err: unknown) {
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'NotSupportedError')) {
        this.element.muted = true;
        await this.element.play();
      } else {
        throw err;
      }
    }
  }
  pause(): void {
    this.element.pause();
  }

  seek(position: number): void {
    if (Number.isFinite(position) && Number.isFinite(this.element.duration) && this.element.duration >= 0) {
      const target = Math.max(0, Math.min(this.element.duration, position));
      this.element.currentTime = target;
    }
  }

  speed(rate: number): void {
    this.element.playbackRate = rate;
  }
  volume(value: number): void {
    this.element.volume = Math.min(1, Math.max(0, value));
  }
  mute(muted: boolean): void {
    this.element.muted = muted;
  }

  unload(): void {
    this.destroyHls();
    clearTimeout(this.stallTimer);
    this.element.pause();
    this.element.removeAttribute('src');
    this.element.removeAttribute('poster');
    this.element.load();
  }

  private destroyHls(): void {
    this.hls?.destroy();
    this.hls = null;
    this.levels = [];
  }

  on(event: VideoEvent, callback: () => void, signal: AbortSignal): void {
    this.element.addEventListener(event, callback, { signal });
  }
}
