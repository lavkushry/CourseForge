/** Durable job UI honesty — progress comes from API state only. */

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | string;

export interface PublicJob {
  id: string;
  lesson_id: string;
  kind: string;
  resource: string;
  state: JobState;
  attempt: number;
  max_attempts: number;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  result?: unknown;
}

/** Kinds that can be retried from the jobs panel with a minimal payload. */
export const RETRIABLE_ADMIN_KINDS = new Set(['index', 'transcribe', 'export']);

export function jobIsTerminal(state: JobState): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled';
}

export function jobCanCancel(state: JobState): boolean {
  return state === 'queued' || state === 'running';
}

export function jobCanRetry(job: Pick<PublicJob, 'kind' | 'state'>): boolean {
  return (job.state === 'failed' || job.state === 'canceled') && RETRIABLE_ADMIN_KINDS.has(job.kind);
}

export function jobProgressLabel(job: Pick<PublicJob, 'state' | 'attempt' | 'max_attempts' | 'error_code'>): string {
  switch (job.state) {
    case 'queued':
      return `Queued · attempt ${job.attempt}/${job.max_attempts}`;
    case 'running':
      return `Running · attempt ${job.attempt}/${job.max_attempts}`;
    case 'completed':
      return 'Completed';
    case 'failed':
      return job.error_code ? `Failed · ${job.error_code}` : 'Failed';
    case 'canceled':
      return 'Canceled';
    default:
      return `Unknown state: ${job.state}`;
  }
}

export function jobEmptyCopy(): { title: string; description: string } {
  return {
    title: 'No jobs yet',
    description: 'Owned jobs appear here with measured queue state. Completion is never invented.',
  };
}

export function jobLoadFailureCopy(message?: string): { title: string; description: string } {
  return {
    title: 'Could not load jobs',
    description: message || 'Job queue temporarily unavailable.',
  };
}

export function jobRetryBlockedCopy(kind: string): string {
  return `Retry from this panel is limited to index/transcribe/export. Resubmit “${kind}” from its product surface with the original payload.`;
}
