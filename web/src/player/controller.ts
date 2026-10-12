import { ApiError, errorMessage, isAbort } from '../api';
import type { Lesson, PlaybackTransport, PlayerPreferences, Pulse, PulseAck, PulseKind } from '../contracts';
import { browserClock } from './clock';
import type { Clock, Timer } from './clock';
import { ProgressDelivery } from './delivery';
import type { DeliveryStatus } from './delivery';
import { EndNavigation } from './navigation';
import { SessionOwnership } from './ownership';
import { PlayerRecovery } from './recovery';
import type { VideoPort, VideoSnapshot } from './video';

export type PlayerState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'suspended' | 'lost' | 'conflict' | 'error' | 'unauthenticated';

interface ControllerOptions {
  video: VideoPort;
  transport: PlaybackTransport;
  preferences(): PlayerPreferences;
  preferencesLoaded(preferences: PlayerPreferences): void;
  speedChanged(speed: number): void;
  visible(): boolean;
  online(): boolean;
  hasNext(): boolean;
  next(): void;
  state(state: PlayerState, message: string): void;
  saved(ack: PulseAck): void;
  delivery(status: DeliveryStatus): void;
  countdown(seconds: number | null): void;
  clock?: Clock;
}

interface CurrentLesson {
  generation: number;
  scope: AbortController;
  ownership: SessionOwnership;
  lesson: Lesson;
  delivery: ProgressDelivery | null;
  recovery: PlayerRecovery | null;
  sequence: number;
  heartbeat: Timer | undefined;
  watchdog: Timer | undefined;
  baseline: { time: number; video: VideoSnapshot; running: boolean };
  position: number;
  lastAdvance: number;
  wantsPlay: boolean;
  reloading: boolean;
  loaded: boolean;
  claiming: boolean;
  suspension: Promise<void> | null;
}

export class PlayerController {
  private readonly clock: Clock;
  private readonly navigation: EndNavigation;
  private current: CurrentLesson | null = null;
  private generation = 0;
  private status: PlayerState = 'idle';

  constructor(private readonly options: ControllerOptions) {
    this.clock = options.clock ?? browserClock;
    this.navigation = new EndNavigation(options.next, options.countdown, this.clock);
  }

  get state(): PlayerState { return this.status; }
  get owns(): boolean { return this.current?.ownership.owns ?? false; }
  get lesson(): Lesson | null { return this.current?.lesson ?? null; }
  get position(): number { return this.current ? this.samplePosition(this.current) : 0; }

  async open(lesson: Lesson, takeOver = false, startPosition?: number): Promise<void> {
    const generation = ++this.generation;
    const previous = this.current;
    this.current = null;
    this.navigation.cancel();
    this.setState('loading', 'Preparing your lesson…');
    if (previous) await this.detach(previous, false);
    if (generation !== this.generation) return;
    const scope = new AbortController();
    const current: CurrentLesson = {
      generation, scope, lesson, ownership: new SessionOwnership(this.options.transport),
      delivery: null, recovery: null, sequence: 0, heartbeat: undefined, watchdog: undefined,
      baseline: { time: this.clock.now(), video: this.options.video.snapshot(), running: false },
      position: 0, lastAdvance: this.clock.now(), wantsPlay: false, reloading: true, loaded: false, claiming: false, suspension: null,
    };
    this.current = current;
    try {
      const session = await current.ownership.open(lesson.id, takeOver, startPosition, scope.signal);
      if (!this.isCurrent(current)) return;
      current.position = session.position;
      current.sequence = session.sequence;
      this.options.preferencesLoaded(session.preferences);
      this.navigation.preference(session.preferences.autoplay);
      this.createDelivery(current);
      this.bindVideo(current);
      current.recovery = new PlayerRecovery({
        allowed: () => this.canPlay(current),
        reload: signal => this.reload(current, signal),
        onAttempt: attempt => { if (this.isCurrent(current)) this.setState('loading', `Reconnecting video (${attempt}/3)…`); },
        onFailure: error => this.failure(current, error),
        clock: this.clock,
      });
      await this.options.video.load(session.media_url, session.position, session.preferences.speed, lesson.captions ?? [], scope.signal);
      if (!this.isCurrent(current)) return;
      current.loaded = true;
      current.reloading = false;
      this.resetBaseline(current);
      this.setState('ready', session.position > 2 ? `Resume from ${formatTime(session.position)}, or restart this lesson.` : 'Ready when you are.');
      this.schedulePulse(current);
      this.watchdog(current);
    } catch (error) {
      if (!this.isCurrent(current) || isAbort(error)) return;
      current.reloading = false;
      if (error instanceof ApiError && error.status === 409 && error.code === 'playback_conflict') {
        this.setState('conflict', 'Your account is playing in another window. Move playback here to continue.');
      } else if (current.recovery && current.ownership.owns && !(error instanceof ApiError && error.terminal)) {
        await current.recovery.recover(error instanceof Error ? error : new Error('The video source could not open.'));
        if (this.isCurrent(current) && current.loaded) { this.schedulePulse(current); this.watchdog(current); }
      } else this.failure(current, error);
    }
  }

  async retry(): Promise<void> {
    const current = this.current;
    if (!current || !this.options.visible() || !this.options.online() || this.status === 'loading') return;
    const position = this.samplePosition(current);
    // open detaches/releases the previous session first. A retry never opts in
    // to takeover; a different window still requires deliberate confirmation.
    await this.open(current.lesson, false, position);
  }

  async requestPlay(takeOver = false): Promise<void> {
    const current = this.current;
    if (!current || !this.options.visible() || !this.options.online() || current.claiming) return;
    this.navigation.cancel();
    const session = current.ownership.current;
    // Displaced sessions remain closed server-side. Deliberate takeover creates
    // a fresh session; an ordinary resume still claims without taking ownership.
    if (takeOver) {
      await this.open(current.lesson, true, session ? this.samplePosition(current) : undefined);
      return;
    }
    if (!session) { await this.open(current.lesson, takeOver); return; }
    current.claiming = true;
    try {
      if (current.suspension) await current.suspension;
      if (!this.isCurrent(current)) return;
      if (!current.ownership.owns || !current.delivery?.active || this.status === 'error') {
        current.delivery?.stop();
        const claim = await current.ownership.claim(takeOver, current.scope.signal);
        if (!this.isCurrent(current)) return;
        if (!claim.owner) throw new ApiError('Playback belongs to another window.', 409, 'playback_conflict');
        current.sequence = claim.sequence;
        current.position = claim.position;
        this.createDelivery(current);
        this.options.video.seek(claim.position);
        this.resetBaseline(current);
      }
      current.wantsPlay = true;
      if (!current.loaded || this.status === 'error') await this.reload(current, current.scope.signal);
      if (!this.canPlay(current)) return;
      await this.options.video.play();
      this.schedulePulse(current);
      this.watchdog(current);
    } catch (error) {
      if (!this.isCurrent(current) || isAbort(error)) return;
      current.wantsPlay = false;
      this.options.video.pause();
      if (error instanceof ApiError && error.status === 409) {
        current.ownership.lost();
        this.setState('conflict', 'Playback is open in another window. Move playback here to continue.');
      } else this.failure(current, error);
    } finally {
      current.claiming = false;
    }
  }

  pause(): void { this.navigation.cancel(); if (this.current) this.current.wantsPlay = false; this.options.video.pause(); }

  seek(position: number): void {
    this.navigation.cancel();
    if (!this.current?.ownership.owns || !Number.isFinite(position)) return;
    this.options.video.seek(position);
  }

  restart(): void { this.seek(0); }

  preferencesChanged(value: PlayerPreferences): void {
    this.navigation.preference(value.autoplay);
    if (this.current && this.options.video.snapshot().rate !== value.speed) this.options.video.speed(value.speed);
  }

  cancelNext(): void { this.navigation.cancel(); }

  async saveNow(): Promise<void> {
    if (this.current?.ownership.owns) await this.emit(this.current, 'heartbeat');
  }

  // Called on hidden/offline transitions. Becoming visible/online is deliberately
  // absent: reclaim requires requestPlay(), originating from an explicit action.
  async suspend(reason: 'hidden' | 'offline'): Promise<void> {
    const current = this.current;
    if (!current) return;
    if (current.suspension) return current.suspension;
    this.navigation.cancel();
    current.wantsPlay = false;
    current.recovery?.stop();
    const pending = current.ownership.owns ? this.emit(current, 'hidden', false) : Promise.resolve(null);
    current.ownership.relinquish();
    current.baseline.running = false;
    this.options.video.pause();
    this.clearTimers(current);
    if (!this.requiresRecoveryAction()) this.setState('suspended', reason === 'offline' ? 'You’re offline. Reconnect, then select Resume here.' : 'Playback paused while this page was hidden. Select Resume here.');
    // Give a reachable server a brief chance to commit the final sample. Neither
    // an unavailable server nor a lost acknowledgement can fabricate watch credit.
    const cleanup = async () => {
      await this.bounded(pending.catch(() => null), 1500);
      current.delivery?.stop();
      await current.ownership.release(true).catch(() => undefined);
    };
    current.suspension = cleanup();
    await current.suspension;
    current.suspension = null;
  }

  async close(keepalive = false): Promise<void> {
    const generation = ++this.generation;
    const current = this.current;
    this.current = null;
    this.navigation.cancel();
    if (current) await this.detach(current, keepalive);
    if (this.generation === generation) this.setState('idle', 'Choose a lesson to begin.');
  }

  private createDelivery(current: CurrentLesson): void {
    const id = current.ownership.current?.id;
    if (!id) return;
    current.delivery = new ProgressDelivery({
      request: (pulse, signal) => this.options.transport.pulse(id, pulse, signal),
      onSaved: ack => {
        if (!this.isCurrent(current)) return;
        this.options.saved(ack);
        if (!ack.owner) this.ownershipLost(current, 'Playback moved to another window. Select Resume here to continue.');
      },
      onError: error => {
        if (!this.isCurrent(current)) return;
        const terminal = error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
        if (terminal) this.failure(current, error);
        else this.ownershipLost(current, errorMessage(error));
      },
      onStatus: status => { if (this.isCurrent(current)) this.options.delivery(status); },
      clock: this.clock,
    });
  }

  private bindVideo(current: CurrentLesson): void {
    const video = this.options.video;
    const on = (event: Parameters<VideoPort['on']>[0], callback: () => void) => video.on(event, () => {
      if (this.isCurrent(current) && !current.reloading) callback();
    }, current.scope.signal);
    on('play', () => {
      if (!this.canPlay(current)) {
        video.pause();
        if (!this.requiresRecoveryAction()) this.setState('suspended', 'Select Resume here to continue.');
        return;
      }
      current.wantsPlay = true;
      current.lastAdvance = this.clock.now();
      this.navigation.cancel();
    });
    on('playing', () => {
      if (!this.canPlay(current)) { video.pause(); return; }
      current.wantsPlay = true;
      this.setState('playing', '');
      this.fire(current, 'playing');
    });
    on('pause', () => {
      current.wantsPlay = false;
      if (current.ownership.owns) { this.fire(current, 'pause'); if (this.status !== 'error') this.setState('paused', 'Paused. Your saved position updates after server acknowledgement.'); }
    });
    on('seeking', () => { this.navigation.cancel(); this.fire(current, 'seek'); });
    on('seeked', () => this.resetBaseline(current));
    on('waiting', () => { current.baseline.running = false; });
    on('ended', () => {
      current.wantsPlay = false;
      this.fire(current, 'ended');
      this.setState('paused', 'Lesson ended.');
      this.navigation.ended(this.options.hasNext());
    });
    on('ratechange', () => {
      this.fire(current, 'seek');
      this.options.speedChanged(video.snapshot().rate);
      this.resetBaseline(current);
    });
    on('timeupdate', () => {
      const snapshot = video.snapshot();
      const advance = snapshot.position - current.position;
      current.position = snapshot.position;
      if (!snapshot.paused && advance > 0 && advance < 2 * snapshot.rate) {
        current.lastAdvance = this.clock.now();
        current.recovery?.healthy(advance / snapshot.rate);
      }
    });
    on('error', () => {
      current.baseline.running = false;
      void current.recovery?.recover(new Error('The video connection stopped. Select Resume here if reconnection fails.'));
    });
  }

  private async reload(current: CurrentLesson, signal: AbortSignal): Promise<void> {
    if (!this.canPlay(current)) return;
    const session = current.ownership.current;
    if (!session) return;
    const position = this.samplePosition(current);
    current.reloading = true;
    current.baseline.running = false;
    try {
      await this.options.video.load(session.media_url, position, this.options.preferences().speed, current.lesson.captions ?? [], signal);
      if (!this.isCurrent(current) || signal.aborted) return;
      current.loaded = true;
      current.reloading = false;
      this.resetBaseline(current);
      if (current.wantsPlay && this.canPlay(current)) await this.options.video.play();
      else this.setState('ready', 'Video reconnected.');
    } finally {
      if (this.isCurrent(current)) current.reloading = false;
    }
  }

  private emit(current: CurrentLesson, kind: PulseKind, visible = this.options.visible()): Promise<PulseAck | null> {
    if (!current.delivery?.active || !current.ownership.owns) return Promise.resolve(null);
    const now = this.clock.now();
    const snapshot = this.options.video.snapshot();
    const position = this.samplePosition(current);
    const wall = Math.max(0, (now - current.baseline.time) / 1000);
    const advance = position - current.baseline.video.position;
    const rate = current.baseline.video.rate;
    const elapsed = current.baseline.running && this.options.online() && kind !== 'seek' && advance > 0 && advance <= wall * rate + 1
      ? Math.max(0, Math.min(20, wall, advance / rate)) : 0;
    const pulse: Pulse = {
      sequence: ++current.sequence, kind, position,
      playing: !snapshot.paused && snapshot.ready && this.options.online() && visible,
      visible, elapsed_seconds: elapsed, playback_rate: snapshot.rate,
    };
    current.baseline = { time: now, video: { ...snapshot, position }, running: pulse.playing && kind !== 'seek' };
    return current.delivery.send(pulse);
  }

  private fire(current: CurrentLesson, kind: PulseKind): void { void this.emit(current, kind).catch(() => undefined); }

  private resetBaseline(current: CurrentLesson): void {
    const snapshot = this.options.video.snapshot();
    current.position = snapshot.position;
    current.baseline = {
      time: this.clock.now(), video: snapshot,
      running: this.canPlay(current) && !snapshot.paused && snapshot.ready,
    };
    current.lastAdvance = this.clock.now();
  }

  private samplePosition(current: CurrentLesson): number {
    const snapshot = this.options.video.snapshot();
    return snapshot.duration > 0 ? snapshot.position : current.position;
  }

  private schedulePulse(current: CurrentLesson): void {
    if (current.heartbeat !== undefined) this.clock.clearTimeout(current.heartbeat);
    if (!this.isCurrent(current) || !current.ownership.owns) return;
    current.heartbeat = this.clock.setTimeout(() => {
      current.heartbeat = undefined;
      if (!this.isCurrent(current) || !current.ownership.owns) return;
      this.fire(current, 'heartbeat');
      this.schedulePulse(current);
    }, 9000 + this.clock.random() * 2000);
  }

  private watchdog(current: CurrentLesson): void {
    if (current.watchdog !== undefined) this.clock.clearTimeout(current.watchdog);
    if (!this.isCurrent(current)) return;
    current.watchdog = this.clock.setTimeout(() => {
      current.watchdog = undefined;
      if (!this.isCurrent(current)) return;
      if (current.wantsPlay && this.clock.now() - current.lastAdvance > 45_000 && !current.recovery?.busy) {
        void current.recovery?.recover(new Error('Video playback stalled. Select Resume here to retry.'));
      }
      this.watchdog(current);
    }, 2500);
  }

  private failure(current: CurrentLesson, error: unknown): void {
    if (!this.isCurrent(current)) return;
    current.wantsPlay = false;
    current.baseline.running = false;
    this.navigation.cancel();
    this.clearTimers(current);
    current.delivery?.stop();
    this.options.video.pause();
    if (error instanceof ApiError && error.status === 401) {
      current.ownership.lost();
      this.setState('unauthenticated', 'Your sign-in expired. Sign in again to continue this lesson.');
    } else if (error instanceof ApiError && error.status === 409) {
      current.ownership.lost();
      this.setState('conflict', 'Playback is open in another window. Move playback here to continue.');
    } else {
      const message = error instanceof ApiError && error.terminal ? errorMessage(error) : `${errorMessage(error)} Select Retry lesson to try again, or return to the course.`;
      this.setState('error', message);
    }
  }

  private ownershipLost(current: CurrentLesson, message: string): void {
    current.ownership.lost();
    current.wantsPlay = false;
    current.baseline.running = false;
    current.recovery?.stop();
    this.navigation.cancel();
    this.clearTimers(current);
    this.options.video.pause();
    this.setState('lost', message);
  }

  private clearTimers(current: CurrentLesson): void {
    if (current.heartbeat !== undefined) this.clock.clearTimeout(current.heartbeat);
    if (current.watchdog !== undefined) this.clock.clearTimeout(current.watchdog);
    current.heartbeat = undefined;
    current.watchdog = undefined;
  }

  private async detach(current: CurrentLesson, keepalive: boolean): Promise<void> {
    const pending = current.ownership.owns ? this.emit(current, 'close') : Promise.resolve(null);
    current.scope.abort();
    current.recovery?.stop();
    this.clearTimers(current);
    this.options.video.unload();
    await this.bounded(pending.catch(() => null), keepalive ? 0 : 1500);
    current.delivery?.stop();
    await current.ownership.release(keepalive).catch(() => undefined);
  }

  private bounded<T>(promise: Promise<T>, delay: number): Promise<T | undefined> {
    return new Promise(resolve => {
      const timer = this.clock.setTimeout(() => resolve(undefined), delay);
      void promise.then(value => { this.clock.clearTimeout(timer); resolve(value); });
    });
  }

  private canPlay(current: CurrentLesson): boolean {
    return this.isCurrent(current) && current.ownership.owns && this.options.visible() && this.options.online();
  }

  private requiresRecoveryAction(): boolean {
    return ['unauthenticated', 'conflict', 'lost', 'error'].includes(this.status);
  }

  private isCurrent(current: CurrentLesson): boolean {
    return this.current === current && this.generation === current.generation && !current.scope.signal.aborted;
  }

  private setState(state: PlayerState, message: string): void { this.status = state; this.options.state(state, message); }
}

export function formatTime(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const remainder = Math.floor(Math.max(0, seconds) % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}
