import type { LearningPath } from '../paths/contracts';
import { parseLearningPaths, parsePath } from '../paths/contracts';
import type { HttpClient } from './http';

export function learningPaths(
  client: HttpClient,
  cursor = '',
  signal?: AbortSignal,
): Promise<{ paths: LearningPath[]; next_cursor: string | null }> {
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  return client.request(`/learning-paths?${query}`, signal ? { signal } : {}).then(parseLearningPaths);
}

export function learningPath(client: HttpClient, id: string, signal?: AbortSignal): Promise<LearningPath> {
  return client.request(`/learning-paths/${encodeURIComponent(id)}`, signal ? { signal } : {}).then(parsePath);
}

export function createLearningPath(
  client: HttpClient,
  goal: string,
  courseIds: string[],
  weeks: number,
  signal?: AbortSignal,
): Promise<LearningPath> {
  return client
    .request('/learning-paths', {
      method: 'POST',
      body: { goal, course_ids: courseIds, target_weeks: weeks, expected_revision: 0 },
      idempotencyKey: crypto.randomUUID(),
      ...(signal ? { signal } : {}),
    })
    .then(parsePath);
}

export function completeStep(
  client: HttpClient,
  pathId: string,
  stepId: string,
  completed: boolean,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<LearningPath> {
  return client
    .request(`/learning-paths/${encodeURIComponent(pathId)}/steps/${encodeURIComponent(stepId)}`, {
      method: 'PUT',
      body: { completed, expected_revision: Math.max(1, expectedRevision) },
      idempotencyKey: crypto.randomUUID(),
      ...(signal ? { signal } : {}),
    })
    .then(parsePath);
}
