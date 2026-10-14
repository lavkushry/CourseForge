import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../src/api';
import { PlanningApi } from '../../src/planning/api';
import { Commands } from '../../src/learning/api';
import {
  active,
  addDays,
  dateInZone,
  focus,
  habits,
  monday,
  preferences,
  remaining,
  weekPreferences,
} from '../../src/planning/contracts';
const f = {
  id: 'focus',
  mode: 'focus',
  status: 'running',
  title: 'Source study',
  duration_seconds: 60,
  elapsed_seconds: 10,
  remaining_seconds: 50,
  revision: 1,
  server_now: '2026-10-13T12:00:00Z',
  created_at: '2026-10-13T11:59:50Z',
};
describe('planning trust and calendar boundaries', () => {
  it('animates only running server snapshots using monotonic elapsed and clamps at zero', () => {
    const s = focus(f);
    expect(remaining(s, 1000, 6000)).toBe(45);
    expect(remaining({ ...s, status: 'paused' }, 1000, 6000)).toBe(50);
    expect(remaining(s, 1000, 999999)).toBe(0);
    expect(remaining(s, 1000, 500)).toBe(50);
  });
  it('restores null active timer and rejects malformed states and excess duration', () => {
    expect(active({ session: null, server_now: f.server_now })).toBeNull();
    expect(() => focus({ ...f, status: 'invented' })).toThrow();
    expect(() => focus({ ...f, duration_seconds: 7300 })).toThrow();
    expect(() => focus({ ...f, remaining_seconds: NaN })).toThrow();
    expect(() => focus({ ...f, elapsed_seconds: 61 })).toThrow();
  });
  it('normalizes Monday without browser locale or daylight saving offset arithmetic', () => {
    expect(monday('2026-01-04')).toBe('2025-12-29');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(dateInZone('America/New_York', new Date('2026-03-08T04:30:00Z'))).toBe('2026-03-07');
    expect(dateInZone('Asia/Kolkata', new Date('2026-03-08T20:00:00Z'))).toBe('2026-03-09');
    expect(() => monday('2026-02-30')).toThrow();
  });
  it('rejects invalid saved budgets and absent revision instead of silently inventing defaults', () => {
    expect(preferences({ daily_minutes: 30, path_id: null, revision: 0 }).daily_minutes).toBe(30);
    expect(() => preferences({ daily_minutes: 5, path_id: null, revision: 0 })).toThrow();
    expect(() => preferences({ daily_minutes: 30, path_id: null })).toThrow();
    expect(() => weekPreferences({ weekday_minutes: [0, 0, 0, 0, 0, 0, 0], revision: 0 })).toThrow();
    expect(() => weekPreferences({ weekday_minutes: [15, 15, 15, 15, 15, 0, 8], revision: 0 })).toThrow();
  });
  it('does not infer habit achievement from timer minutes or hide reminder unavailability', () => {
    const h = habits({
      day: '2026-10-13',
      today: { watched_seconds: 0, lessons: 0, quizzes: 0, reviews: 0, goal_met: false },
      week: { watched_seconds: 0, lessons: 0, quizzes: 0, reviews: 0, active_days: 0 },
      streak: 0,
      best_streak: 0,
      preferences: { goal: 'minutes', timezone: 'UTC', reminder_email: true, initialized: true },
      email_available: true,
      reminder_delivery_available: false,
      timezone_anchored: true,
    });
    expect(h.today.goal_met).toBe(false);
    expect(h.reminder_delivery_available).toBe(false);
    expect(() => habits({ ...h, today: { ...h.today, watched_seconds: -1 } })).toThrow();
  });
});
describe('planning command ownership', () => {
  it('preserves uncertain retry key/body, changes key on edits, clears on account disposal', () => {
    const ledger = new Commands();
    const a = ledger.get('start', { duration_minutes: 25 });
    expect(ledger.get('start', { duration_minutes: 25 }).key).toBe(a.key);
    expect(ledger.get('start', { duration_minutes: 30 }).key).not.toBe(a.key);
    ledger.clear();
    expect(ledger.get('start', { duration_minutes: 25 }).key).not.toBe(a.key);
  });
  it('submits explicit status revision and stable idempotency key without client elapsed or credit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(f)));
    const api = new PlanningApi(new ApiClient(fetcher));
    const s = focus(f);
    await api.focusAction(s, 'pause', 'stable', new AbortController().signal);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe('/api/v1/focus/sessions/focus/actions');
    expect(JSON.parse(String(options?.body))).toEqual({ action: 'pause', expected_revision: 1 });
    expect((options?.headers as Record<string, string>)['Idempotency-Key']).toBe('stable');
    expect(options?.credentials).toBe('same-origin');
  });
});
