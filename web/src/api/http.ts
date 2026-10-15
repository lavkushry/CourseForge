import { ApiError, isAbort, isRecord } from './errors';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | undefined;
  body?: unknown;
  signal?: AbortSignal | undefined;
  keepalive?: boolean | undefined;
  idempotencyKey?: string | undefined;
}

/** Shared cookie-auth HTTP client. Provider credentials never appear here. */
export class HttpClient {
  protected csrf = '';

  constructor(protected readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = this.csrf;
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    try {
      const response = await this.fetcher(`/api/v1${path}`, {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        headers,
        signal: controller.signal,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        ...(options.keepalive !== undefined ? { keepalive: options.keepalive } : {}),
      });
      if (!response.ok) {
        const data: unknown = await response.json().catch(() => null);
        const envelope = isRecord(data) && isRecord(data.error) ? data.error : null;
        const detail =
          isRecord(data) && typeof data.detail === 'string'
            ? data.detail
            : envelope && typeof envelope.message === 'string'
              ? envelope.message
              : `Request failed (${response.status}).`;
        const code =
          isRecord(data) && typeof data.code === 'string'
            ? data.code
            : envelope && typeof envelope.code === 'string'
              ? envelope.code
              : '';
        const retry = response.headers.get('Retry-After');
        const retryAfterMs = retry
          ? Math.min(30_000, Math.max(0, Number(retry) * 1000 || Date.parse(retry) - Date.now()))
          : 0;
        throw new ApiError(detail, response.status, code, retryAfterMs);
      }
      if (response.status === 204 || response.headers.get('Content-Length') === '0') return undefined as T;
      return (await response.json()) as T;
    } catch (error) {
      if (isAbort(error) && !options.signal?.aborted) {
        throw new ApiError('Request timed out.', 504);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  protected setCsrf(token: string): void {
    this.csrf = token;
  }

  protected clearCsrf(): void {
    this.csrf = '';
  }
}
