import { describe, expect, it } from 'vitest';
import { parseAuth, parseClaim, parsePlaybackSession, parsePreferences, parsePulseAck } from '../../src/validation';
import { session } from './fixtures';

describe('server contract validation', () => {
  it('requires account identity and CSRF before opening the authenticated interface', () => {
    expect(() => parseAuth({ user: { id: '', email: 'learner@example.test' }, csrf_token: 'csrf' })).toThrow();
    expect(() => parseAuth({ user: { id: 'learner', email: 'learner@example.test' }, csrf_token: 7 })).toThrow();
  });
  it('rejects provider URLs, invalid sequence and invalid saved position before opening media', () => {
    expect(() => parsePlaybackSession({ ...session(), media_url: 'https://odysee.example/video.mp4' })).toThrow();
    expect(() => parsePlaybackSession({ ...session(), sequence: 0.5 })).toThrow();
    expect(() => parsePlaybackSession({ ...session(), position: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => parsePlaybackSession({ ...session(), owner: 'true' })).toThrow();
  });
  it('rejects nonsensical credit and ownership acknowledgements', () => {
    const ack = { sequence: 1, position: 10, watched_seconds: 10, coverage: 10, owner: true, completed: false };
    for (const change of [
      { watched_seconds: -1 },
      { coverage: 101 },
      { position: NaN },
      { sequence: Number.MAX_SAFE_INTEGER + 1 },
      { completed: 'false' },
      { owner: 1 },
    ]) {
      expect(() => parsePulseAck({ ...ack, ...change })).toThrow();
    }
    expect(parsePulseAck(ack)).toEqual(ack);
  });
  it('does not invent valid preferences or leases from malformed values', () => {
    expect(() => parsePreferences({ speed: 999, autoplay: false })).toThrow();
    expect(() => parsePreferences({ speed: 1, autoplay: 'true' })).toThrow();
    expect(() => parseClaim({ owner: true, position: -1, sequence: 3 })).toThrow();
  });
});
