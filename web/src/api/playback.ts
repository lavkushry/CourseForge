import type { ClaimResponse, PlaybackSession, PlayerPreferences, Pulse, PulseAck } from '../contracts';
import { parseClaim, parsePlaybackSession, parsePreferences, parsePulseAck } from '../validation';
import type { HttpClient } from './http';

export function create(
  client: HttpClient,
  lessonId: string,
  takeOver: boolean,
  startPosition: number | undefined,
  signal: AbortSignal,
): Promise<PlaybackSession> {
  return client
    .request('/playback/sessions', {
      method: 'POST',
      signal,
      body: {
        lesson_id: lessonId,
        take_over: takeOver,
        ...(startPosition !== undefined ? { start_position: startPosition } : {}),
      },
    })
    .then(parsePlaybackSession);
}

export function pulse(
  client: HttpClient,
  sessionId: string,
  pulseBody: Pulse,
  signal: AbortSignal,
): Promise<PulseAck> {
  return client
    .request(`/playback/sessions/${encodeURIComponent(sessionId)}/pulse`, {
      method: 'POST',
      body: pulseBody,
      signal,
    })
    .then(parsePulseAck);
}

export async function release(
  client: HttpClient,
  sessionId: string,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  await client.request(`/playback/sessions/${encodeURIComponent(sessionId)}/release`, {
    method: 'POST',
    body: {},
    ...options,
  });
}

export function claim(
  client: HttpClient,
  sessionId: string,
  takeOver: boolean,
  signal: AbortSignal,
): Promise<ClaimResponse> {
  return client
    .request(`/playback/sessions/${encodeURIComponent(sessionId)}/claim`, {
      method: 'POST',
      body: { take_over: takeOver },
      signal,
    })
    .then(parseClaim);
}

export function preferences(client: HttpClient, signal: AbortSignal): Promise<PlayerPreferences> {
  return client.request('/player/preferences', signal ? { signal } : {}).then(parsePreferences);
}

export function savePreferences(
  client: HttpClient,
  prefs: PlayerPreferences,
  signal: AbortSignal,
): Promise<PlayerPreferences> {
  return client
    .request('/player/preferences', { method: 'PUT', body: prefs, signal })
    .then(parsePreferences);
}
