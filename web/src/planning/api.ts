import type { ApiClient } from '../api';
import * as c from './contracts';
const id = encodeURIComponent;
export class PlanningApi {
  constructor(private readonly api: ApiClient) {}
  preferences(signal: AbortSignal) {
    return this.api.request('/planner/preferences', { signal }).then(c.preferences);
  }
  savePreferences(
    body: { daily_minutes: number; path_id: string | null; expected_revision: number },
    key: string,
    signal: AbortSignal,
  ) {
    return this.api
      .request('/planner/preferences', { method: 'PUT', body, idempotencyKey: key, signal })
      .then(c.preferences);
  }
  weekPreferences(signal: AbortSignal) {
    return this.api.request('/planner/week-preferences', { signal }).then(c.weekPreferences);
  }
  saveWeekPreferences(
    body: { weekday_minutes: number[]; expected_revision: number },
    key: string,
    signal: AbortSignal,
  ) {
    return this.api
      .request('/planner/week-preferences', { method: 'PUT', body, idempotencyKey: key, signal })
      .then(c.weekPreferences);
  }
  day(date: string, signal: AbortSignal) {
    return this.api.request(`/planner/days/${id(date)}`, { signal }).then(c.day);
  }
  generateDay(
    body: { study_date: string; refresh: boolean; expected_revision: number },
    key: string,
    signal: AbortSignal,
  ) {
    return this.api.request('/planner/days', { method: 'POST', body, idempotencyKey: key, signal }).then(c.day);
  }
  status(item: c.Item, status: c.Item['status'], key: string, signal: AbortSignal) {
    return this.api
      .request(`/planner/items/${id(item.id)}`, {
        method: 'PUT',
        body: { status, expected_revision: item.revision },
        idempotencyKey: key,
        signal,
      })
      .then(c.day);
  }
  actual(item: c.Item, minutes: number, key: string, signal: AbortSignal) {
    return this.api
      .request(`/planner/items/${id(item.id)}/actual`, {
        method: 'PUT',
        body: { actual_minutes: minutes, expected_revision: item.revision },
        idempotencyKey: key,
        signal,
      })
      .then(c.day);
  }
  week(date: string, signal: AbortSignal) {
    return this.api.request(`/planner/weeks/${id(date)}`, { signal }).then(c.week);
  }
  generateWeek(
    body: { week_start: string; refresh: boolean; expected_revision: number },
    key: string,
    signal: AbortSignal,
  ) {
    return this.api.request('/planner/weeks', { method: 'POST', body, idempotencyKey: key, signal }).then(c.week);
  }
  active(signal: AbortSignal) {
    return this.api.request('/focus/active', { signal }).then(c.active);
  }
  start(
    body: {
      mode: 'focus' | 'break';
      duration_minutes: number;
      title: string;
      planner_item_id?: string;
      lesson_id?: string;
      lab_session_id?: string;
    },
    key: string,
    signal: AbortSignal,
  ) {
    return this.api.request('/focus/sessions', { method: 'POST', body, idempotencyKey: key, signal }).then(c.focus);
  }
  focusAction(
    f: c.Focus,
    action: 'pause' | 'resume' | 'finish' | 'cancel' | 'hidden',
    key: string,
    signal: AbortSignal,
    keepalive = false,
  ) {
    return this.api
      .request(`/focus/sessions/${id(f.id)}/actions`, {
        method: 'POST',
        body: { action, expected_revision: f.revision },
        idempotencyKey: key,
        signal,
        keepalive,
      })
      .then(c.focus);
  }
  history(signal: AbortSignal, cursor = '') {
    const q = new URLSearchParams({ limit: '20' });
    if (cursor) q.set('cursor', cursor);
    return this.api.request(`/focus/history?${q}`, { signal }).then(c.focusHistory);
  }
  analytics(date: string, signal: AbortSignal) {
    return this.api.request(`/focus/analytics/${id(date)}`, { signal }).then(c.analytics);
  }
  habits(signal: AbortSignal) {
    return this.api.request('/me/habits', { signal }).then(c.habits);
  }
  saveHabits(
    body: { goal: 'minutes' | 'lesson'; timezone: string; reminder_email: boolean },
    key: string,
    signal: AbortSignal,
  ) {
    return this.api
      .request('/me/habit-preferences', { method: 'PUT', body, idempotencyKey: key, signal })
      .then(c.habits);
  }
  insights(signal: AbortSignal) {
    return this.api.request('/studio/insights', { signal }).then(c.insights);
  }
}
