import type HlsType from 'hls.js';
import { bufferedEnd } from './media-buffer';

export type QualityLevel = { index: number; height: number; bitrate: number; label: string };

export type HlsEngineEvents = {
  onLevels(levels: QualityLevel[]): void;
  onLevelSwitched(level: QualityLevel | null): void;
  onError(message: string, fatal: boolean): void;
  onStall(diagnostics: StallDiagnostics): void;
  onBitrateSwitch(): void;
};

export interface StallDiagnostics {
  currentTime: number;
  bufferedEnd: number;
  readyState: number;
  networkState: number;
  at: number;
}

export interface HlsEngine {
  attach(media: HTMLVideoElement, src: string, signal: AbortSignal): Promise<void>;
  setQuality(levelIndex: number | 'auto'): void;
  getLevels(): QualityLevel[];
  destroy(): void;
}

const LOW_MEMORY =
  typeof navigator !== 'undefined' &&
  ((navigator as Navigator & { deviceMemory?: number }).deviceMemory !== undefined
    ? ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4
    : /Android|iPhone|iPad/i.test(navigator.userAgent));

export function nativeHlsSupported(video: HTMLVideoElement): boolean {
  const type = video.canPlayType('application/vnd.apple.mpegurl');
  return type === 'probably' || type === 'maybe';
}

function levelLabel(height: number, bitrate: number): string {
  if (height > 0) return `${height}p`;
  if (bitrate > 0) return `${Math.round(bitrate / 1000)}kbps`;
  return 'Auto';
}

function mapLevels(hls: HlsType): QualityLevel[] {
  return (hls.levels || []).map((level, index) => ({
    index,
    height: level.height || 0,
    bitrate: level.bitrate || 0,
    label: levelLabel(level.height || 0, level.bitrate || 0),
  }));
}

export async function createHlsEngine(events: Partial<HlsEngineEvents> = {}): Promise<HlsEngine> {
  const mod = await import('hls.js');
  const Hls = mod.default;
  if (!Hls.isSupported()) {
    throw new Error('HLS.js is not supported in this browser.');
  }

  let hls: HlsType | null = null;
  let networkRetries = 0;
  let mediaRetries = 0;

  const destroy = () => {
    if (hls) {
      hls.destroy();
      hls = null;
    }
  };

  return {
    async attach(media, src, signal) {
      destroy();
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: LOW_MEMORY ? 20 : 40,
        maxMaxBufferLength: LOW_MEMORY ? 40 : 80,
        maxBufferSize: LOW_MEMORY ? 30 * 1000 * 1000 : 60 * 1000 * 1000,
        maxBufferHole: 0.5,
        startLevel: -1,
        abrEwmaDefaultEstimate: 500_000,
        backBufferLength: LOW_MEMORY ? 30 : 90,
      });
      const instance = hls;
      const onAbort = () => destroy();
      signal.addEventListener('abort', onAbort, { once: true });

      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        events.onLevels?.(mapLevels(instance));
      });
      instance.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        const levels = mapLevels(instance);
        events.onBitrateSwitch?.();
        events.onLevelSwitched?.(levels.find(l => l.index === data.level) ?? null);
      });
      instance.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) {
          if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
            events.onStall?.({
              currentTime: media.currentTime,
              bufferedEnd: bufferedEnd(media),
              readyState: media.readyState,
              networkState: media.networkState,
              at: Date.now(),
            });
          }
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 3) {
          networkRetries += 1;
          const delay = Math.min(8000, 400 * 2 ** networkRetries);
          events.onError?.(`Network error; retry ${networkRetries}/3`, false);
          window.setTimeout(() => {
            if (signal.aborted || !hls) return;
            hls.startLoad();
          }, delay);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries < 3) {
          mediaRetries += 1;
          events.onError?.(`Media error; recover ${mediaRetries}/3`, false);
          try {
            instance.recoverMediaError();
          } catch {
            events.onError?.('Fatal media error', true);
            destroy();
          }
          return;
        }
        events.onError?.(data.reason || data.details || 'Fatal HLS error', true);
        destroy();
      });

      instance.loadSource(src);
      instance.attachMedia(media);
      if (signal.aborted) {
        destroy();
        throw new DOMException('Cancelled', 'AbortError');
      }
    },
    setQuality(levelIndex) {
      if (!hls) return;
      if (levelIndex === 'auto') {
        hls.currentLevel = -1;
        return;
      }
      hls.currentLevel = levelIndex;
    },
    getLevels() {
      return hls ? mapLevels(hls) : [];
    },
    destroy,
  };
}
