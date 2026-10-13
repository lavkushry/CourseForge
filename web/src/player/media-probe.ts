import { ApiError, isAbort } from '../api';

// HTML video exposes a MediaError rather than the gateway's HTTP status. A HEAD
// request distinguishes expired access from a retryable provider outage without
// downloading video bytes. The gateway remains the sole authorization boundary.
export async function probeMedia(path: string, signal: AbortSignal, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<void> {
  const scope = new AbortController();
  const abort = () => scope.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => scope.abort(), 20_000);
  if (signal.aborted) scope.abort();
  try {
    const response = await fetcher(path, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: scope.signal });
    if (scope.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (response.ok) return;
    const messages: Record<number, string> = {
      401: 'Your sign-in expired. Sign in again to continue this lesson.',
      403: 'Your access to this lesson changed. Return to the course to check your enrollment.',
      404: 'This playback session is no longer available. Retry the lesson to open a new session.',
      409: 'Playback moved to another window. Move playback here to continue.',
      410: 'This playback session expired. Retry the lesson to open a new session.',
      429: 'The video provider is busy. We will retry briefly; your saved progress is safe.',
      502: 'The video provider could not serve this lesson. Your saved progress is safe.',
      503: 'The video source is temporarily unavailable. Your saved progress is safe.',
      504: 'The video source took too long to respond. Your saved progress is safe.',
    };
    const retry = Number(response.headers.get('Retry-After'));
    throw new ApiError(messages[response.status] || 'This video could not open. Retry the lesson or return to the course.', response.status, response.status === 409 ? 'playback_conflict' : 'media_unavailable', Number.isFinite(retry) ? Math.max(0, Math.min(30_000, retry * 1000)) : 0);
  } catch (error) {
    if (isAbort(error) && !signal.aborted) throw new ApiError('The video source took too long to respond. Retry this lesson.', 504, 'media_timeout');
    throw error;
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
  }
}
