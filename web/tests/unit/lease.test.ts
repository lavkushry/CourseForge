import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api';
import type { Lesson } from '../../src/contracts';
import { PlayerController } from '../../src/player/controller';
import { probeMedia } from '../../src/player/media-probe';
import { clock, FakeVideo, transport } from './fixtures';

const lesson: Lesson = { id: 'lesson-1', course_id: 'course-1', title: 'First lesson', duration_seconds: 120 };
const conflict = () => new ApiError('Playback is open in another window.', 409, 'playback_conflict');

function setup() {
  const video = new FakeVideo();
  const server = transport();
  const state = vi.fn();
  const controller = new PlayerController({
    video,
    transport: server,
    clock,
    visible: () => true,
    online: () => true,
    preferences: () => ({ autoplay: false, speed: 1 }),
    preferencesLoaded: vi.fn(),
    speedChanged: vi.fn(),
    hasNext: () => true,
    next: vi.fn(),
    state,
    saved: vi.fn(),
    delivery: vi.fn(),
    countdown: vi.fn(),
  });
  return { controller, video, server, state };
}

describe('lapsed playback lease', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reclaims once without takeover on a 409 and loads the same session', async () => {
    const { controller, video, server } = setup();
    const load = vi.spyOn(video, 'load').mockRejectedValueOnce(conflict());
    await controller.open(lesson);
    expect(server.claim).toHaveBeenCalledOnce();
    expect(vi.mocked(server.claim).mock.calls[0]?.[1]).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
    expect(controller.state).toBe('ready');
    expect(controller.owns).toBe(true);
    await controller.close();
  });

  it('falls back to the move-playback prompt when another window owns the lease', async () => {
    const { controller, video, server, state } = setup();
    vi.spyOn(video, 'load').mockRejectedValue(conflict());
    vi.mocked(server.claim).mockResolvedValueOnce({ owner: false, position: 0, sequence: 20 });
    await controller.open(lesson);
    expect(server.claim).toHaveBeenCalledOnce();
    expect(controller.state).toBe('conflict');
    expect(JSON.stringify(state.mock.calls.at(-1))).toMatch(/another window/);
    expect(JSON.stringify(state.mock.calls)).not.toMatch(/access to this lesson changed/i);
    await controller.close();
  });

  it('never reclaims on a real 403 denial', async () => {
    const { controller, video, server } = setup();
    vi.spyOn(video, 'load').mockRejectedValue(
      new ApiError('Your access to this lesson changed.', 403, 'media_unavailable'),
    );
    await controller.open(lesson);
    expect(server.claim).not.toHaveBeenCalled();
    expect(controller.state).toBe('error');
    await controller.close();
  });
});

describe('media probe wording', () => {
  it('says a lesson without a source is not available yet', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 503, headers: { 'X-CourseForge-Media': 'no-source' } }));
    await expect(probeMedia('/media/x', new AbortController().signal, fetcher)).rejects.toMatchObject({
      status: 503,
      code: 'media_not_ready',
      message: expect.stringContaining("This video isn't available yet"),
    });
  });
  it('keeps the transient wording for a provider outage', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503, headers: { 'Retry-After': '5' } }));
    await expect(probeMedia('/media/x', new AbortController().signal, fetcher)).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('temporarily unavailable'),
    });
  });
  it('maps a lapsed lease to playback_conflict', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 409 }));
    await expect(probeMedia('/media/x', new AbortController().signal, fetcher)).rejects.toMatchObject({
      status: 409,
      code: 'playback_conflict',
    });
  });
});
