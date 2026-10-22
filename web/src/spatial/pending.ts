import type { SpatialKind } from './model';

export interface PendingSpatialOpen {
  lectureId: string;
  kind: SpatialKind;
  startSeconds: number;
}

const KEY = 'courseforge.spatial.pending';

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function rememberSpatialOpen(pending: PendingSpatialOpen): void {
  const store = storage();
  if (!store) return;
  store.setItem(KEY, JSON.stringify(pending));
}

export function takeSpatialOpen(lectureId: string): PendingSpatialOpen | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(KEY);
  store.removeItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingSpatialOpen>;
    if (parsed.lectureId !== lectureId) return null;
    if (parsed.kind !== '3d' && parsed.kind !== 'ar' && parsed.kind !== 'vr') return null;
    if (typeof parsed.startSeconds !== 'number' || !Number.isFinite(parsed.startSeconds)) return null;
    return { lectureId, kind: parsed.kind, startSeconds: parsed.startSeconds };
  } catch {
    return null;
  }
}
