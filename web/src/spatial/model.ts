export type SpatialKind = '3d' | 'ar' | 'vr';
export type SpatialDecision = 'release' | 'label' | 'hold';

/** Read model for one grounded spatial asset. Evidence is the source transcript, when present. */
export interface SpatialAsset {
  lecture_id: string;
  concept_ids: string[];
  start_seconds: number;
  end_seconds: number;
  asset_url: string;
  kind: SpatialKind;
  decision: SpatialDecision;
  evidence?: string;
  labels?: string[];
}

export interface SpatialScene {
  lecture_id: string;
  concept_ids: string[];
  start_seconds: number;
  end_seconds: number;
  kind: SpatialKind;
  evidence: string;
  labels?: string[];
}

export interface LectureWatch {
  lessonId: string;
  completed: boolean;
  positionSeconds: number;
}

export const SPATIAL_GROUND_TRUTH =
  'Optional spatial view. The original lecture video remains the ground truth.';

export const SPATIAL_PLAN_NOTE =
  'Optional. Not a required step. The original lecture video remains the ground truth.';

export function formatLectureTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function labelWarning(startSeconds: number): string {
  return `AI-generated — verify against original lecture at ${formatLectureTimestamp(startSeconds)}`;
}

export function kindLabel(kind: SpatialKind): string {
  switch (kind) {
    case '3d':
      return '3D';
    case 'ar':
      return 'AR';
    case 'vr':
      return 'VR';
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

export function exploreLabel(kinds: readonly SpatialKind[]): string {
  const names = kinds.map(kindLabel);
  if (names.length === 0) return '';
  if (names.length === 1) return `Explore in ${names[0]}`;
  const last = names[names.length - 1];
  return `Explore in ${names.slice(0, -1).join(' / ')} / ${last}`;
}

function isKind(value: unknown): value is SpatialKind {
  return value === '3d' || value === 'ar' || value === 'vr';
}

function isDecision(value: unknown): value is SpatialDecision {
  return value === 'release' || value === 'label' || value === 'hold';
}

export function isSafeAssetURL(url: string, lectureId: string, kind: SpatialKind): boolean {
  if (!url.startsWith('/api/v1/lessons/') || url.includes('://') || url.includes('..') || url.startsWith('//')) {
    return false;
  }
  return url === `/api/v1/lessons/${lectureId}/spatial/scene?kind=${kind}`;
}

export function parseSpatialAsset(value: unknown): SpatialAsset | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.lecture_id !== 'string' || record.lecture_id.trim() === '') return null;
  if (!Array.isArray(record.concept_ids) || record.concept_ids.length === 0) return null;
  const concept_ids: string[] = [];
  for (const id of record.concept_ids) {
    if (typeof id !== 'string' || id.trim() === '') return null;
    concept_ids.push(id);
  }
  if (typeof record.start_seconds !== 'number' || typeof record.end_seconds !== 'number') return null;
  if (!Number.isFinite(record.start_seconds) || !Number.isFinite(record.end_seconds)) return null;
  if (record.start_seconds < 0 || record.end_seconds <= record.start_seconds) return null;
  if (!isKind(record.kind) || !isDecision(record.decision)) return null;
  if (typeof record.asset_url !== 'string' || !isSafeAssetURL(record.asset_url, record.lecture_id, record.kind)) {
    return null;
  }
  const asset: SpatialAsset = {
    lecture_id: record.lecture_id,
    concept_ids,
    start_seconds: record.start_seconds,
    end_seconds: record.end_seconds,
    asset_url: record.asset_url,
    kind: record.kind,
    decision: record.decision,
  };
  if (typeof record.evidence === 'string' && record.evidence.trim() !== '') asset.evidence = record.evidence;
  if (Array.isArray(record.labels)) {
    const labels = record.labels.filter((label): label is string => typeof label === 'string' && label.trim() !== '');
    if (labels.length > 0) asset.labels = labels;
  }
  return asset;
}

export function parseSpatialAssets(value: unknown): SpatialAsset[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { assets?: unknown }).assets)
      ? (value as { assets: unknown[] }).assets
      : null;
  if (!list) return [];
  const assets: SpatialAsset[] = [];
  for (const item of list) {
    const asset = parseSpatialAsset(item);
    if (asset) assets.push(asset);
  }
  return assets;
}

/** Held assets never reach an Explore control. */
export function visibleAssets(assets: readonly SpatialAsset[]): SpatialAsset[] {
  return assets.filter(asset => {
    switch (asset.decision) {
      case 'release':
      case 'label':
        return true;
      case 'hold':
        return false;
      default: {
        const unreachable: never = asset.decision;
        return unreachable;
      }
    }
  });
}

export function assetsForRange(assets: readonly SpatialAsset[], start: number, end: number): SpatialAsset[] {
  const point = !(end > start);
  return visibleAssets(assets).filter(asset => {
    if (point) return start >= asset.start_seconds && start <= asset.end_seconds;
    return asset.start_seconds < end && start < asset.end_seconds;
  });
}

export function assetsForPosition(assets: readonly SpatialAsset[], position?: number): SpatialAsset[] {
  const visible = visibleAssets(assets);
  if (position === undefined) return visible;
  return visible.filter(asset => position >= asset.start_seconds && position <= asset.end_seconds);
}

/** Prefer a released asset so high confidence opens directly. */
export function preferredAsset(assets: readonly SpatialAsset[]): SpatialAsset | null {
  const visible = visibleAssets(assets);
  return visible.find(asset => asset.decision === 'release') ?? visible[0] ?? null;
}

/**
 * Opening a spatial view does not create a lesson, move progress, or complete the lecture.
 * The returned record is the lecture the existing pulse path already owns.
 */
export function watchAfterSpatialOpen(watch: LectureWatch, _asset: SpatialAsset): LectureWatch {
  return {
    lessonId: watch.lessonId,
    completed: watch.completed,
    positionSeconds: watch.positionSeconds,
  };
}

export function planActionIsRequired(): false {
  return false;
}
