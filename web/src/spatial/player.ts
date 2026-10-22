import type { ApiClient } from '../api';
import { takeSpatialOpen } from './pending';
import { mountSpatialDialog, renderExploreControl, type SpatialAsset } from './ui';

export interface SpatialPlayerHandle {
  refresh(): void;
  open(asset: SpatialAsset): void;
}

export function mountSpatialPlayer(options: {
  wrap: HTMLElement;
  timeline: HTMLElement;
  video: HTMLVideoElement;
  api: ApiClient;
  signal: AbortSignal;
  getAssets(): readonly SpatialAsset[];
  seek(seconds: number): void;
  onOpened(asset: SpatialAsset): void;
  onClosed(): void;
}): SpatialPlayerHandle {
  const dialog = mountSpatialDialog(
    options.wrap,
    options.api,
    {
      seek: options.seek,
      onClosed: options.onClosed,
    },
    options.signal,
  );
  let marker: HTMLElement | null = null;
  let moment: SpatialAsset | null = null;

  const place = () => {
    if (!marker || !moment) return;
    const timelineRect = options.timeline.getBoundingClientRect();
    const wrapRect = options.wrap.getBoundingClientRect();
    const duration = options.video.duration;
    const ratio =
      Number.isFinite(duration) && duration > 0 ? Math.min(1, Math.max(0, moment.start_seconds / duration)) : 0;
    const x = timelineRect.left - wrapRect.left + ratio * timelineRect.width;
    marker.style.left = `${x}px`;
    marker.style.top = `${timelineRect.top - wrapRect.top}px`;
  };

  const refresh = () => {
    dialog.close();
    marker?.remove();
    marker = null;
    moment = null;
    const assets = options.getAssets();
    const first = assets.find(asset => asset.decision !== 'hold');
    if (!first) return;
    const group = assets.filter(
      asset =>
        asset.decision !== 'hold' &&
        asset.start_seconds === first.start_seconds &&
        asset.end_seconds === first.end_seconds,
    );
    moment = first;
    const control = renderExploreControl(group, asset => open(asset), { className: 'spatial-marker' });
    if (!control) return;
    control.style.transform = 'translate(-50%, -120%)';
    marker = control;
    options.wrap.append(control);
    place();
  };

  const open = (asset: SpatialAsset) => {
    if (asset.decision === 'hold') return;
    options.seek(asset.start_seconds);
    dialog.open(asset);
    options.onOpened(asset);
  };

  for (const eventName of ['loadedmetadata', 'durationchange', 'resize']) {
    options.video.addEventListener(eventName, place, { signal: options.signal });
  }
  window.addEventListener('resize', place, { signal: options.signal });
  options.signal.addEventListener('abort', () => marker?.remove());
  refresh();

  return {
    refresh,
    open(asset: SpatialAsset) {
      open(asset);
    },
  };
}

export function consumePendingSpatial(
  lectureId: string,
  assets: readonly SpatialAsset[],
  open: (asset: SpatialAsset) => void,
): void {
  const pending = takeSpatialOpen(lectureId);
  if (!pending) return;
  const asset = assets.find(item => item.kind === pending.kind && item.decision !== 'hold');
  if (asset) open(asset);
}
