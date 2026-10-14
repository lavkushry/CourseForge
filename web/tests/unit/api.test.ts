import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '../../src/api';
import { sameOriginMediaPath } from '../../src/player/video';

describe('authenticated API and media boundary', () => {
  it('uses same-origin cookies and the server CSRF token for protected writes', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ user: { id: 'learner-1', email: 'learner@example.test' }, csrf_token: 'csrf-test-token' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ApiClient(fetcher);
    await client.me();
    await client.release('playback-1');
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/v1/playback/sessions/playback-1/release');
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'X-CSRF-Token': 'csrf-test-token' },
    });
  });

  it('retains the conflict code and bounded retry delay instead of pretending success', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Another player is open.', code: 'playback_conflict' }), {
        status: 409,
        headers: { 'Retry-After': '999999' },
      }),
    );
    const client = new ApiClient(fetcher);
    await expect(client.create('lesson-1', false, undefined, new AbortController().signal)).rejects.toMatchObject({
      status: 409,
      code: 'playback_conflict',
      retryAfterMs: 30_000,
    });
  });

  it('rejects provider URLs and accepts only the same-origin media gateway', () => {
    expect(sameOriginMediaPath('/media/v1/sessions/abc?token=signed', 'https://academy.test')).toBe(
      '/media/v1/sessions/abc?token=signed',
    );
    expect(sameOriginMediaPath('/api/v1/playback/sessions/play_abc/media?t=signed', 'https://academy.test')).toBe(
      '/api/v1/playback/sessions/play_abc/media?t=signed',
    );
    expect(() =>
      sameOriginMediaPath('https://odysee.test/private.mp4?credential=secret', 'https://academy.test'),
    ).toThrow();
    expect(() => sameOriginMediaPath('//evil.test/media/stream', 'https://academy.test')).toThrow();
    expect(() => sameOriginMediaPath('/api/v1/auth/me', 'https://academy.test')).toThrow();
    expect(new ApiError('expired', 401).terminal).toBe(true);
  });

  it('understands the Go identity/catalog error envelope without hiding the failure code', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: 'Progress changed; read before retrying.', code: 'stale_progress' } }),
          { status: 409 },
        ),
      );
    const client = new ApiClient(fetcher);
    await expect(client.saveProgress('lesson-1', 10, 100, 5)).rejects.toMatchObject({
      status: 409,
      code: 'stale_progress',
      message: 'Progress changed; read before retrying.',
    });
  });
});
