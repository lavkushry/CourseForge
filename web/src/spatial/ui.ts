import '@google/model-viewer/dist/model-viewer.min.js';
import type { ApiClient } from '../api';
import { loadLectureSpatial } from './catalog';
import { requestSpatialOpen } from './pending';
import { enterSpatialVr, type VrHandle } from './vr-session';
import {
  SPATIAL_GROUND_TRUTH,
  SPATIAL_PLAN_NOTE,
  assetsForRange,
  exploreLabel,
  formatLectureTimestamp,
  kindLabel,
  labelWarning,
  visibleAssets,
  type SpatialAsset,
  type SpatialKind,
  type SpatialScene,
} from './model';

export { SPATIAL_GROUND_TRUTH, SPATIAL_PLAN_NOTE, assetsForRange, exploreLabel, labelWarning, visibleAssets };
export type { SpatialAsset, SpatialKind };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function renderExploreControl(
  assets: readonly SpatialAsset[],
  onPick: (asset: SpatialAsset) => void,
  options: { optional?: boolean; className?: string } = {},
): HTMLElement | null {
  const visible = visibleAssets(assets);
  if (visible.length === 0) return null;
  const label = exploreLabel(visible.map(asset => asset.kind)) + (options.optional ? ' (optional)' : '');
  const root = el('div', options.className ? `spatial-explore ${options.className}` : 'spatial-explore');
  root.addEventListener('pointerdown', event => event.stopPropagation());
  root.addEventListener('click', event => event.stopPropagation());

  const open = (asset: SpatialAsset) => {
    switch (asset.decision) {
      case 'release':
      case 'label':
        onPick(asset);
        return;
      case 'hold':
        return;
      default: {
        const unreachable: never = asset.decision;
        void unreachable;
      }
    }
  };

  if (visible.length === 1) {
    const only = visible[0];
    if (!only) return null;
    const button = el('button', 'spatial-explore-button', label);
    button.type = 'button';
    button.addEventListener('click', () => open(only));
    root.append(button);
    return root;
  }

  const button = el('button', 'spatial-explore-button', label);
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-haspopup', 'menu');
  const menu = el('div', 'spatial-explore-menu');
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  button.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
  });
  for (const asset of visible) {
    const item = el('button', 'spatial-explore-mode', `Explore in ${kindLabel(asset.kind)}`);
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.addEventListener('click', () => {
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      open(asset);
    });
    menu.append(item);
  }
  root.append(button, menu);
  return root;
}

export function appendExploreCitation(
  parent: HTMLElement,
  api: ApiClient,
  citation: { lesson_id: string; start_seconds: number },
  onOpen: (seconds: number) => void,
): void {
  void loadLectureSpatial(api, citation.lesson_id)
    .then(assets => {
      if (!parent.isConnected) return;
      const match = assets.filter(
        asset => citation.start_seconds >= asset.start_seconds - 1 && citation.start_seconds <= asset.end_seconds + 1,
      );
      const control = renderExploreControl(match, asset => {
        requestSpatialOpen({
          lectureId: asset.lecture_id,
          kind: asset.kind,
          startSeconds: asset.start_seconds,
        });
        onOpen(asset.start_seconds);
      });
      if (control) parent.append(control);
    })
    .catch(() => undefined);
}

export function renderPlanExplore(
  assets: readonly SpatialAsset[],
  onPick: (asset: SpatialAsset) => void,
): HTMLElement | null {
  const control = renderExploreControl(assets, onPick, { optional: true, className: 'spatial-plan-action' });
  if (!control) return null;
  const wrap = el('div', 'spatial-plan-offer');
  wrap.append(control, el('p', 'muted spatial-plan-note', SPATIAL_PLAN_NOTE));
  return wrap;
}

async function readScene(api: ApiClient, asset: SpatialAsset, signal: AbortSignal): Promise<SpatialScene | null> {
  if (!asset.asset_url.startsWith('/api/v1/')) return null;
  try {
    const body = await api.request<unknown>(asset.asset_url.replace(/^\/api\/v1/, ''), { signal });
    if (!body || typeof body !== 'object') return null;
    const record = body as Record<string, unknown>;
    if (record.kind !== asset.kind || record.lecture_id !== asset.lecture_id) return null;
    if (typeof record.evidence !== 'string') return null;
    const labels = Array.isArray(record.labels)
      ? record.labels.filter((label): label is string => typeof label === 'string' && label.trim() !== '')
      : (asset.labels ?? []);
    const scene: SpatialScene = {
      lecture_id: asset.lecture_id,
      concept_ids: asset.concept_ids,
      start_seconds: asset.start_seconds,
      end_seconds: asset.end_seconds,
      kind: asset.kind,
      evidence: record.evidence,
    };
    if (labels.length > 0) scene.labels = labels;
    return scene;
  } catch {
    return null;
  }
}

export interface SpatialDialog {
  open(asset: SpatialAsset): void;
  close(): void;
}

export function mountSpatialDialog(
  host: HTMLElement,
  api: ApiClient,
  actions: { seek(seconds: number): void; onClosed(): void },
  signal: AbortSignal,
): SpatialDialog {
  const dialog = el('dialog', 'spatial-dialog');
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('close', () => actions.onClosed());
  host.append(dialog);
  let sceneScope = new AbortController();
  let vr: VrHandle | null = null;
  signal.addEventListener('abort', () => {
    sceneScope.abort();
    dialog.remove();
  });

  function close(): void {
    const active = vr;
    vr = null;
    void active?.end();
    if (dialog.open) dialog.close();
  }

  function open(asset: SpatialAsset): void {
    if (asset.decision === 'hold') return;
    sceneScope.abort();
    sceneScope = new AbortController();
    const scope = sceneScope;
    dialog.replaceChildren();
    const card = el('div', 'spatial-dialog-card');
    card.append(
      el('p', 'spatial-ground-truth', SPATIAL_GROUND_TRUTH),
      el('h2', 'spatial-dialog-title', `${kindLabel(asset.kind)} spatial view`),
    );
    if (asset.decision === 'label') {
      const warning = el('p', 'spatial-label-warning', labelWarning(asset.start_seconds));
      warning.setAttribute('role', 'status');
      card.append(warning);
    }
    const back = el(
      'button',
      'button spatial-return',
      `Return to lecture at ${formatLectureTimestamp(asset.start_seconds)}`,
    );
    back.type = 'button';
    back.addEventListener('click', () => {
      actions.seek(asset.start_seconds);
      close();
    });
    card.append(back);
    const stage = el('div', 'spatial-stage');
    if (asset.labels && asset.labels.length > 0) {
      const row = el('div', 'spatial-label-row');
      for (const label of asset.labels) row.append(el('span', 'spatial-label', label));
      stage.append(row);
    }
    const model = document.createElement('model-viewer');
    model.setAttribute('src', asset.asset_url.replace('/spatial/scene?', '/spatial/model?'));
    model.setAttribute('alt', asset.labels?.join(', ') || 'Spatial view');
    model.setAttribute('camera-controls', '');
    model.setAttribute('shadow-intensity', '1');
    if (asset.kind === 'ar') {
      model.setAttribute('ar', '');
      model.setAttribute('ar-modes', 'webxr scene-viewer quick-look');
      model.setAttribute('ar-placement', 'floor');
    }
    stage.append(model);
    if (asset.kind === 'vr') {
      const enter = el('button', 'button spatial-vr-enter', 'Enter VR');
      enter.type = 'button';
      enter.addEventListener('click', () => {
        if (vr) {
          const active = vr;
          vr = null;
          void active.end().then(() => {
            enter.textContent = 'Enter VR';
          });
          return;
        }
        const src = model.getAttribute('src') ?? '';
        void enterSpatialVr(src)
          .then(handle => {
            if (!handle) {
              enter.textContent = 'No VR headset. Drag to inspect the model.';
              return;
            }
            vr = handle;
            enter.textContent = 'Exit VR';
            void handle.ended.then(() => {
              if (vr === handle) vr = null;
              enter.textContent = 'Enter VR';
            });
          })
          .catch(() => {
            enter.textContent = 'This device cannot enter VR. Drag to inspect the model.';
          });
      });
      stage.append(enter);
    }
    const evidence = el('p', 'spatial-evidence', asset.evidence ?? '');
    if (!asset.evidence) evidence.hidden = true;
    stage.append(evidence);
    card.append(stage);
    const dismiss = el('button', 'button quiet spatial-close', 'Close spatial view');
    dismiss.type = 'button';
    dismiss.addEventListener('click', () => close());
    card.append(dismiss);
    dialog.append(card);
    if (!dialog.open) dialog.showModal();
    void readScene(api, asset, scope.signal).then(scene => {
      if (scope.signal.aborted || !scene?.evidence) return;
      evidence.hidden = false;
      evidence.textContent = scene.evidence;
    });
  }

  return { open, close };
}
