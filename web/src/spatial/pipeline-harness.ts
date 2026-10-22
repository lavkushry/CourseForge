import type { ApiClient } from '../api/client';
import { SPATIAL_OPEN_EVENT, type PendingSpatialOpen } from './pending';
import './spatial.css';
import { appendExploreCitation, mountSpatialDialog, renderExploreControl, renderPlanExplore } from './ui';
import type { SpatialAsset, SpatialKind } from './model';

const labels = ['API Gateway', 'Auth', 'Orders', 'Queue'];
const evidence = 'API Gateway\nAuth\nOrders\nQueue';

function asset(lectureId: string, kind: SpatialKind, decision: SpatialAsset['decision']): SpatialAsset {
  return {
    lecture_id: lectureId,
    concept_ids: ['kco_gateway'],
    start_seconds: 18,
    end_seconds: 36,
    asset_url: `/api/v1/lessons/${lectureId}/spatial/scene?kind=${kind}`,
    kind,
    decision,
    labels,
  };
}

const visible = [
  asset('lec-diagram', '3d', 'release'),
  asset('lec-diagram', 'ar', 'label'),
  asset('lec-diagram', 'vr', 'release'),
];

const api = {
  async request(path: string): Promise<unknown> {
    if (path.startsWith('/lessons/lec-diagram/spatial/scene')) {
      const kind = new URL(path, 'http://courseforge.local').searchParams.get('kind');
      return {
        lecture_id: 'lec-diagram',
        kind,
        evidence,
        labels,
        concept_ids: ['kco_gateway'],
        start_seconds: 18,
        end_seconds: 36,
      };
    }
    if (path === '/lessons/lec-diagram/spatial') {
      return { lecture_id: 'lec-diagram', assets: visible };
    }
    if (path === '/lessons/lec-held/spatial') {
      return { lecture_id: 'lec-held', assets: [asset('lec-held', 'vr', 'hold')] };
    }
    throw new Error(path);
  },
} as unknown as ApiClient;

const seek = document.querySelector<HTMLElement>('#seek');
const opened = document.querySelector<HTMLElement>('#opened');
const player = document.querySelector<HTMLElement>('#player');
const citations = document.querySelector<HTMLElement>('#citations');
const plan = document.querySelector<HTMLElement>('#plan');
const held = document.querySelector<HTMLElement>('#held');
if (!seek || !opened || !player || !citations || !plan || !held) {
  throw new Error('spatial pipeline harness is missing a mount point');
}

window.addEventListener(SPATIAL_OPEN_EVENT, event => {
  const detail = (event as CustomEvent<PendingSpatialOpen>).detail;
  opened.textContent = detail ? `${detail.kind}:${detail.startSeconds}` : '';
});

const dialog = mountSpatialDialog(
  player,
  api,
  {
    seek: seconds => {
      seek.textContent = String(seconds);
    },
    onClosed: () => undefined,
  },
  new AbortController().signal,
);

const control = renderExploreControl(visible, asset => dialog.open(asset));
if (control) player.append(control);

appendExploreCitation(citations, api, { lesson_id: 'lec-diagram', start_seconds: 18 }, seconds => {
  seek.textContent = String(seconds);
});
appendExploreCitation(held, api, { lesson_id: 'lec-held', start_seconds: 18 }, () => undefined);

const offer = renderPlanExplore(visible, () => undefined);
if (offer) plan.append(offer);
