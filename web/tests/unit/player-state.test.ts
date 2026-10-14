import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lesson } from '../../src/contracts';
import { PlayerController, type PlayerState } from '../../src/player/controller';
import { clock, FakeVideo, session, transport } from './fixtures';

const lesson: Lesson = { id: 'lesson-1', course_id: 'course-1', title: 'First lesson', duration_seconds: 120 };

describe('player state machine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const video = new FakeVideo();
    const server = transport();
    const states: PlayerState[] = [];
    const controller = new PlayerController({
      video,
      transport: server,
      clock,
      visible: () => true,
      online: () => true,
      preferences: () => ({ autoplay: false, speed: 1 }),
      preferencesLoaded: vi.fn(),
      speedChanged: vi.fn(),
      hasNext: () => false,
      next: vi.fn(),
      state: s => {
        states.push(s);
      },
      saved: vi.fn(),
      delivery: vi.fn(),
      countdown: vi.fn(),
    });
    return { controller, video, server, states };
  }

  it('transitions idle → loading → ready → playing → paused', async () => {
    const { controller, video, states } = setup();
    expect(controller.state).toBe('idle');
    const open = controller.open(lesson);
    expect(states).toContain('loading');
    await open;
    expect(controller.state).toBe('ready');
    await controller.requestPlay();
    expect(controller.state).toBe('playing');
    expect(video.value.paused).toBe(false);
    controller.pause();
    expect(controller.state).toBe('paused');
    await controller.close();
  });

  it('surfaces conflict when create returns playback_conflict', async () => {
    const { controller, server, states } = setup();
    const { ApiError } = await import('../../src/api');
    vi.mocked(server.create).mockRejectedValue(new ApiError('conflict', 409, 'playback_conflict'));
    await controller.open(lesson);
    expect(states.at(-1)).toBe('conflict');
  });

  it('loads HLS URL when the session provides one', async () => {
    const { controller, video, server } = setup();
    vi.mocked(server.create).mockResolvedValue({
      ...session(),
      hls_url: '/api/v1/playback/sessions/session-1/hls/master.m3u8?t=tok',
      poster_url: '/api/v1/playback/sessions/session-1/poster?t=tok',
    });
    await controller.open(lesson);
    expect(video.loaded[0]).toContain('/media/');
    await controller.close();
  });
});
