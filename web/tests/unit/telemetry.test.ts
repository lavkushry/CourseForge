import { describe, expect, it } from 'vitest';
import { PlayerTelemetry, validateTelemetryClient } from '../../src/player/telemetry';

describe('player telemetry', () => {
  it('validates small payloads', () => {
    expect(
      validateTelemetryClient({
        session_id: 'ps_1',
        startup_ms: 10,
        rebuffer_ms: 0,
        play_ms: 1000,
        errors: 0,
        bitrate_switches: 1,
      }),
    ).toBe(true);
    expect(
      validateTelemetryClient({
        session_id: '',
        startup_ms: 10,
        rebuffer_ms: 0,
        play_ms: 1000,
        errors: 0,
        bitrate_switches: 0,
      }),
    ).toBe(false);
  });

  it('accumulates play/rebuffer and flushes once', async () => {
    const samples: Array<ReturnType<PlayerTelemetry['sample']>> = [];
    const t = new PlayerTelemetry({
      post: async sample => {
        samples.push(sample);
      },
    });
    t.open('ps_abc');
    t.markReady();
    t.markPlaying();
    t.markWaiting();
    t.markPlaying();
    t.markBitrateSwitch();
    await t.flush();
    await t.flush();
    expect(samples).toHaveLength(1);
    expect(samples[0]?.session_id).toBe('ps_abc');
    expect(samples[0]?.bitrate_switches).toBe(1);
    expect(samples[0]?.startup_ms).toBeGreaterThanOrEqual(0);
  });
});
