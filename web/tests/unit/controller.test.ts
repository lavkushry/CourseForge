import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api';
import type { Lesson, PlaybackSession, PlayerPreferences, Pulse } from '../../src/contracts';
import { PlayerController } from '../../src/player/controller';
import { acknowledgement, clock, deferred, FakeVideo, session, transport } from './fixtures';

const lesson: Lesson = { id: 'lesson-1', course_id: 'course-1', title: 'First lesson', duration_seconds: 120 };

function setup() {
  const video = new FakeVideo();
  const server = transport();
  let visible = true;
  let online = true;
  let preferences: PlayerPreferences = { autoplay: false, speed: 1 };
  const state = vi.fn();
  const saved = vi.fn();
  const next = vi.fn();
  const controller = new PlayerController({
    video,
    transport: server,
    clock,
    visible: () => visible,
    online: () => online,
    preferences: () => preferences,
    preferencesLoaded: value => {
      preferences = value;
    },
    speedChanged: vi.fn(),
    hasNext: () => true,
    next,
    state,
    saved,
    delivery: vi.fn(),
    countdown: vi.fn(),
  });
  return {
    controller,
    video,
    server,
    saved,
    state,
    next,
    setVisible(value: boolean) {
      visible = value;
    },
    setOnline(value: boolean) {
      online = value;
    },
  };
}

describe('player lifecycle and watch accounting', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses one jittered periodic transport and credits only real advancement', async () => {
    const { controller, video, server } = setup();
    await controller.open(lesson);
    await controller.requestPlay();
    video.value.position = 10;
    await vi.advanceTimersByTimeAsync(10_000);
    const calls = vi.mocked(server.pulse).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toMatchObject({ kind: 'playing', sequence: 1, elapsed_seconds: 0 });
    expect(calls[1]?.[1]).toMatchObject({ kind: 'heartbeat', sequence: 2, elapsed_seconds: 10 });
    await controller.close();
  });

  it('seeking to the end cannot invent watch coverage or trigger autoplay before ended', async () => {
    const { controller, video, server, next } = setup();
    vi.mocked(server.create).mockResolvedValue({ ...session(), preferences: { autoplay: true, speed: 1 } });
    await controller.open(lesson);
    await controller.requestPlay();
    controller.seek(119);
    video.event('timeupdate');
    await vi.advanceTimersByTimeAsync(3000);
    expect(next).not.toHaveBeenCalled();
    expect(vi.mocked(server.pulse).mock.calls.at(-1)?.[1]).toMatchObject({ kind: 'seek', elapsed_seconds: 0 });
    video.value.position = 120;
    video.value.paused = true;
    video.value.ended = true;
    video.event('ended');
    await vi.advanceTimersByTimeAsync(5000);
    expect(next).toHaveBeenCalledOnce();
    await controller.close();
  });

  it('pauses and releases on hide, never steals ownership on visibility/reconnect, and claims deliberately', async () => {
    const test = setup();
    await test.controller.open(lesson);
    await test.controller.requestPlay();
    test.setVisible(false);
    await test.controller.suspend('hidden');
    expect(test.video.value.paused).toBe(true);
    expect(test.server.release).toHaveBeenCalledOnce();
    expect(test.controller.owns).toBe(false);
    test.setVisible(true);
    test.setOnline(false);
    test.setOnline(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.server.claim).not.toHaveBeenCalled();
    await test.controller.requestPlay();
    expect(test.server.claim).toHaveBeenCalledOnce();
    expect(test.controller.owns).toBe(true);
    expect(
      vi
        .mocked(test.server.pulse)
        .mock.calls.slice(-2)
        .map(call => ({ sequence: call[1].sequence, kind: call[1].kind })),
    ).toEqual([
      { sequence: 21, kind: 'seek' },
      { sequence: 22, kind: 'playing' },
    ]);
    await test.controller.close();
  });

  it('stops media and periodic requests when the lease is no longer owned', async () => {
    const test = setup();
    vi.mocked(test.server.pulse).mockImplementation(async (_id: string, pulse: Pulse) => acknowledgement(pulse, false));
    await test.controller.open(lesson);
    await test.controller.requestPlay();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.controller.owns).toBe(false);
    expect(test.controller.state).toBe('lost');
    expect(test.video.value.paused).toBe(true);
    const count = vi.mocked(test.server.pulse).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.server.pulse).toHaveBeenCalledTimes(count);
    await test.controller.close();
  });

  it('does not claim another window after an intentional hide pulse returns non-owner', async () => {
    const test = setup();
    await test.controller.open(lesson);
    await test.controller.requestPlay();
    await test.controller.suspend('hidden');
    expect(test.controller.state).toBe('suspended');
    expect(test.controller.owns).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.controller.state).toBe('suspended');
    await test.controller.close();
  });

  it('does not apply an old lesson response to the new generation and releases its stale lease', async () => {
    const test = setup();
    const old = deferred<PlaybackSession>();
    vi.mocked(test.server.create)
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(session('session-2'));
    const loadingOld = test.controller.open(lesson);
    const newer = { ...lesson, id: 'lesson-2', title: 'New lesson' };
    await test.controller.open(newer);
    old.resolve(session('session-old'));
    await loadingOld;
    expect(test.controller.lesson?.id).toBe('lesson-2');
    expect(test.video.loaded).toEqual(['/media/v1/sessions/session-2']);
    expect(test.server.release).toHaveBeenCalledWith('session-old');
    await test.controller.close();
  });

  it('recovers a transient startup failure and keeps one owned session', async () => {
    const test = setup();
    const load = vi.spyOn(test.video, 'load').mockRejectedValueOnce(new ApiError('provider unavailable', 503));
    const opening = test.controller.open(lesson);
    await vi.advanceTimersByTimeAsync(1000);
    await opening;
    expect(test.controller.state).toBe('ready');
    expect(load).toHaveBeenCalledTimes(2);
    expect(test.server.create).toHaveBeenCalledOnce();
    await test.controller.close();
  });

  it('stops401 recovery and never automatically steals ownership during deliberate retry', async () => {
    const test = setup();
    vi.spyOn(test.video, 'load').mockRejectedValueOnce(new ApiError('expired', 401));
    await test.controller.open(lesson);
    expect(test.controller.state).toBe('unauthenticated');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.server.create).toHaveBeenCalledOnce();
    vi.mocked(test.server.create).mockRejectedValueOnce(new ApiError('other window', 409, 'playback_conflict'));
    await test.controller.retry();
    expect(test.server.release).toHaveBeenCalledWith('session-1', { keepalive: false });
    expect(vi.mocked(test.server.create).mock.calls.at(-1)?.[1]).toBe(false);
    expect(test.controller.state).toBe('conflict');
    await test.controller.close();
  });

  it('keeps expired sign-in recovery visible through later lifecycle and native play events', async () => {
    const test = setup();
    vi.mocked(test.server.pulse).mockRejectedValueOnce(new ApiError('expired', 401));
    await test.controller.open(lesson);
    await test.controller.requestPlay();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.controller.state).toBe('unauthenticated');
    test.setVisible(false);
    await test.controller.suspend('hidden');
    expect(test.controller.state).toBe('unauthenticated');
    test.video.event('play');
    expect(test.controller.state).toBe('unauthenticated');
    expect(test.video.value.paused).toBe(true);
    await test.controller.close();
  });

  it('deliberate takeover opens a fresh session at the current position instead of claiming the displaced session', async () => {
    const test = setup();
    await test.controller.open(lesson);
    test.video.value.position = 24;
    vi.mocked(test.server.create).mockResolvedValueOnce({ ...session('fresh-session'), position: 24 });
    await test.controller.requestPlay(true);
    expect(test.server.claim).not.toHaveBeenCalled();
    expect(vi.mocked(test.server.create).mock.calls.at(-1)?.slice(0, 3)).toEqual([lesson.id, true, 24]);
    expect(test.server.release).toHaveBeenCalledWith('session-1', { keepalive: false });
    expect(test.controller.state).toBe('ready');
    expect(test.video.value.position).toBe(24);
    await test.controller.close();
  });

  it('waiting without position advancement earns no estimated watch time', async () => {
    const test = setup();
    await test.controller.open(lesson);
    await test.controller.requestPlay();
    test.video.event('waiting');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.mocked(test.server.pulse).mock.calls.at(-1)?.[1].elapsed_seconds).toBe(0);
    await test.controller.close();
  });
});
