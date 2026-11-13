import type { HttpClient } from './http';
import type { PublicJob } from '../jobs/status';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid job response');
  }
  return value as Record<string, unknown>;
}

export function parsePublicJob(value: unknown): PublicJob {
  const data = object(value);
  if (typeof data.id !== 'string' || !data.id) throw new Error('Invalid job id');
  if (typeof data.lesson_id !== 'string' || !data.lesson_id) throw new Error('Invalid job lesson_id');
  if (typeof data.kind !== 'string' || !data.kind) throw new Error('Invalid job kind');
  if (typeof data.state !== 'string' || !data.state) throw new Error('Invalid job state');
  const job: PublicJob = {
    id: data.id,
    lesson_id: data.lesson_id,
    kind: data.kind,
    resource: typeof data.resource === 'string' ? data.resource : '',
    state: data.state,
    attempt: typeof data.attempt === 'number' ? data.attempt : 0,
    max_attempts: typeof data.max_attempts === 'number' ? data.max_attempts : 0,
    error_code: typeof data.error_code === 'string' ? data.error_code : null,
    created_at: typeof data.created_at === 'string' ? data.created_at : '',
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : '',
  };
  if (data.result !== undefined) job.result = data.result;
  return job;
}

export function parseJobList(value: unknown): { jobs: PublicJob[]; next_cursor: string } {
  const data = object(value);
  if (!Array.isArray(data.jobs)) throw new Error('Invalid jobs list');
  return {
    jobs: data.jobs.map(parsePublicJob),
    next_cursor: typeof data.next_cursor === 'string' ? data.next_cursor : '',
  };
}

export function listJobs(
  client: HttpClient,
  limit = 50,
  cursor = '',
  signal?: AbortSignal,
): Promise<{ jobs: PublicJob[]; next_cursor: string }> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return client.request(`/jobs?${query}`, signal ? { signal } : {}).then(parseJobList);
}

export function getJob(client: HttpClient, id: string, signal?: AbortSignal): Promise<PublicJob> {
  return client.request(`/jobs/${encodeURIComponent(id)}`, signal ? { signal } : {}).then(parsePublicJob);
}

export function cancelJob(
  client: HttpClient,
  id: string,
  signal?: AbortSignal,
): Promise<{ canceled: boolean }> {
  return client.request(`/jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: {},
    ...(signal ? { signal } : {}),
  });
}

export function submitJob(
  client: HttpClient,
  command: { kind: string; lesson_id: string; payload?: Record<string, unknown> },
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<PublicJob> {
  return client
    .request('/jobs', {
      method: 'POST',
      body: {
        kind: command.kind,
        lesson_id: command.lesson_id,
        payload: command.payload ?? { version: 1 },
      },
      idempotencyKey,
      ...(signal ? { signal } : {}),
    })
    .then(parsePublicJob);
}

export function getKnowledgeJob(
  client: HttpClient,
  id: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return client.request(`/knowledge/jobs/${encodeURIComponent(id)}`, signal ? { signal } : {});
}
