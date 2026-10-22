import { ApiError, isAbort } from '../api';
import type { ApiClient } from '../api';
import { spatialFixture } from './fixture';
import { parseSpatialAssets, visibleAssets, type SpatialAsset } from './model';

export function vendoredSpatialAssets(): SpatialAsset[] {
  return spatialFixture.map(asset => ({ ...asset, concept_ids: [...asset.concept_ids] }));
}

/**
 * Load the stored spatial read model for one lecture.
 * A missing route falls back to the vendored artifact for that lecture id only.
 * Held assets are removed before any learning surface sees them.
 */
export async function loadLectureSpatial(
  api: ApiClient,
  lectureId: string,
  signal?: AbortSignal,
): Promise<SpatialAsset[]> {
  try {
    const body = await api.request<unknown>(
      `/lessons/${encodeURIComponent(lectureId)}/spatial`,
      signal ? { signal } : {},
    );
    return visibleAssets(parseSpatialAssets(body).filter(asset => asset.lecture_id === lectureId));
  } catch (error) {
    if (isAbort(error)) throw error;
    if (error instanceof ApiError && error.status !== 404) return [];
    return visibleAssets(vendoredSpatialAssets().filter(asset => asset.lecture_id === lectureId));
  }
}
