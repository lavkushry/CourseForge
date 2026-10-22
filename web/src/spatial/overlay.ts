import '@google/model-viewer/dist/model-viewer.min.js';
import './overlay.css';
import { FIXTURE_ARTIFACT } from './fixture';
import { describeSource, formatExactTimestamp, placementAttribute, returnSeekSeconds } from './provenance';
import type { SpatialArtifact } from './types';

type ArSessionStatus = 'not-presenting' | 'session-started' | 'object-placed' | 'failed';

interface ModelViewerElement extends HTMLElement {
  canActivateAR: boolean;
}

export interface SpatialOverlayOptions {
  artifact?: SpatialArtifact;
  onReturn: (seconds: number) => void;
  signal?: AbortSignal;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function arStatusMessage(status: ArSessionStatus, canActivate: boolean): string {
  switch (status) {
    case 'not-presenting':
      return canActivate
        ? 'AR is available. Placement is automatic on the floor.'
        : 'This device cannot start AR. Drag to rotate the same model.';
    case 'session-started':
      return 'AR session started. Move the phone until a floor is found.';
    case 'object-placed':
      return 'Placed on the detected surface. Walk around the model.';
    case 'failed':
      return 'AR did not start. Drag to rotate the same model.';
    default: {
      const unexpected: never = status;
      return unexpected;
    }
  }
}

function readArStatus(value: string | null): ArSessionStatus {
  switch (value) {
    case 'session-started':
    case 'object-placed':
    case 'failed':
    case 'not-presenting':
      return value;
    default:
      return 'not-presenting';
  }
}

export function openSpatialOverlay(options: SpatialOverlayOptions): HTMLDialogElement {
  const artifact = options.artifact ?? FIXTURE_ARTIFACT;
  document.getElementById('spatial-ar-dialog')?.remove();
  const seconds = returnSeekSeconds(artifact);
  const stamp = formatExactTimestamp(seconds);
  const dialog = element('dialog', 'spatial-ar-dialog');
  dialog.id = 'spatial-ar-dialog';
  dialog.setAttribute('aria-labelledby', 'spatial-ar-title');

  const body = element('div', 'spatial-ar-dialog__body');
  const heading = element('div', 'spatial-ar-dialog__heading');
  const titles = element('div');
  const title = element('h2', '', artifact.title);
  title.id = 'spatial-ar-title';
  const timestamp = element('p', 'spatial-ar-timestamp', `Lecture timestamp ${stamp}`);
  titles.append(title, timestamp);
  const close = element('button', 'spatial-ar-close', 'Close');
  close.type = 'button';
  close.addEventListener('click', () => dialog.close());
  heading.append(titles, close);

  const viewer = document.createElement('model-viewer') as ModelViewerElement;
  viewer.className = 'spatial-ar-viewer';
  viewer.setAttribute('src', artifact.modelUrl);
  viewer.setAttribute('alt', artifact.title);
  viewer.setAttribute('ar', '');
  viewer.setAttribute('ar-modes', 'webxr scene-viewer quick-look');
  viewer.setAttribute('ar-placement', placementAttribute(artifact.placement));
  viewer.setAttribute('camera-controls', '');
  viewer.setAttribute('interaction-prompt', 'auto');
  viewer.setAttribute('touch-action', 'pan-y');
  viewer.setAttribute('shadow-intensity', '1');

  const span = artifact.nodes.length;
  artifact.nodes.forEach((node, index) => {
    const hotspot = element('button', 'spatial-ar-hotspot', node.label);
    hotspot.type = 'button';
    hotspot.slot = `hotspot-${node.id}`;
    const x = (index - (span - 1) / 2) * 1.4;
    hotspot.dataset.position = `${x} 0.72 0`;
    hotspot.dataset.normal = '0 1 0';
    viewer.append(hotspot);
  });

  const status = element('p', 'spatial-ar-status');
  status.setAttribute('role', 'status');
  const refreshStatus = () => {
    status.textContent = arStatusMessage(readArStatus(viewer.getAttribute('ar-status')), viewer.canActivateAR);
  };
  viewer.addEventListener('ar-status', event => {
    const detail = (event as CustomEvent<{ status?: string }>).detail;
    status.textContent = arStatusMessage(readArStatus(detail?.status ?? null), viewer.canActivateAR);
  });
  viewer.addEventListener('load', refreshStatus);
  refreshStatus();

  const limits = element(
    'p',
    'spatial-ar-limits',
    'Desktop browsers keep this rotatable model. Android Chrome can place it on the floor with Scene Viewer or WebXR. iPhone Safari uses Quick Look when the browser can build a USDZ from this model.',
  );

  const evidence = element('ul', 'spatial-ar-evidence');
  for (const node of artifact.nodes) {
    evidence.append(element('li', '', `${describeSource(node.source)}: ${node.label} (${node.evidence})`));
  }
  for (const item of artifact.context) {
    evidence.append(
      element(
        'li',
        '',
        `${describeSource(item.source)} ${formatExactTimestamp(item.startMs / 1000)}–${formatExactTimestamp(item.endMs / 1000)}: ${item.quote}`,
      ),
    );
  }

  const actions = element('div', 'spatial-ar-actions');
  const back = element('button', 'spatial-ar-return', `Return to ${stamp}`);
  back.type = 'button';
  back.dataset.seekSeconds = String(seconds);
  back.addEventListener('click', () => {
    dialog.close();
    options.onReturn(seconds);
  });
  actions.append(back);

  body.append(heading, viewer, status, limits, evidence, actions);
  dialog.append(body);
  dialog.addEventListener('close', () => dialog.remove());
  options.signal?.addEventListener('abort', () => dialog.close(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

export function seekLectureClock(seconds: number, seek: (seconds: number) => void): void {
  const video = document.querySelector<HTMLVideoElement>('#lesson-video');
  if (video) {
    const duration = video.duration;
    video.currentTime = Number.isFinite(duration) ? Math.min(Math.max(0, seconds), duration) : Math.max(0, seconds);
  }
  seek(seconds);
}
