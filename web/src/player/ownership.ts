import type { ClaimResponse, PlaybackSession, PlaybackTransport } from '../contracts';
import { parseClaim, parsePlaybackSession } from '../validation';

export type OwnershipState = 'empty' | 'owned' | 'released' | 'lost';

export class SessionOwnership {
  private session: PlaybackSession | null = null;
  private state: OwnershipState = 'empty';

  constructor(private readonly transport: PlaybackTransport) {}

  get current(): PlaybackSession | null { return this.session; }
  get owns(): boolean { return this.state === 'owned'; }
  get status(): OwnershipState { return this.state; }

  async open(lessonId: string, takeOver: boolean, startPosition: number | undefined, signal: AbortSignal): Promise<PlaybackSession> {
    const session = parsePlaybackSession(await this.transport.create(lessonId, takeOver, startPosition, signal));
    if (signal.aborted) {
      await this.transport.release(session.id).catch(() => undefined);
      throw new DOMException('Lesson changed.', 'AbortError');
    }
    this.session = session;
    this.state = session.owner ? 'owned' : 'lost';
    return session;
  }

  lost(): void { this.state = 'lost'; }

  relinquish(): void { this.state = 'released'; }

  async release(keepalive = false): Promise<void> {
    const session = this.session;
    if (!session || this.state === 'empty') return;
    this.state = 'released';
    await this.transport.release(session.id, { keepalive });
  }

  async claim(takeOver: boolean, signal: AbortSignal): Promise<ClaimResponse> {
    if (!this.session) throw new Error('Open a lesson before resuming playback.');
    const ack = parseClaim(await this.transport.claim(this.session.id, takeOver, signal));
    if (signal.aborted) throw new DOMException('Lesson changed.', 'AbortError');
    this.state = ack.owner ? 'owned' : 'lost';
    this.session.position = ack.position;
    this.session.sequence = ack.sequence;
    return ack;
  }
}
