import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api';
import { probeMedia } from '../../src/player/media-probe';

describe('authorized media status probe', () => {
  it('uses HEAD and same-site credentials, never fetches a body', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await probeMedia('/api/v1/playback/sessions/synthetic/media?t=synthetic', new AbortController().signal, fetcher);
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'HEAD', credentials: 'same-origin', cache: 'no-store' }));
  });
  it('preserves terminal authorization status and retryable provider status separately', async () => {
    for (const status of [401, 403, 404, 409, 410, 429, 503]) {
      const fetcher = vi.fn().mockResolvedValue(new Response(null, { status, headers: { 'Retry-After': '900' } }));
      try { await probeMedia('/media/synthetic', new AbortController().signal, fetcher); throw new Error('Unexpected success'); }
      catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).status).toBe(status); expect((error as ApiError).retryAfterMs).toBe(30_000); }
    }
  });
  it('aborts a pending probe when the lesson is disposed', async () => {
    const parent = new AbortController();
    const fetcher = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    }));
    const pending = probeMedia('/media/synthetic', parent.signal, fetcher); parent.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });
});
