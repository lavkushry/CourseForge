export interface Action {
  view: string;
  lesson_id?: string;
  position?: number;
  path_id?: string;
  step_id?: string;
  lab_slug?: string;
  review_card_ids?: string[];
}
export interface Item {
  id: string;
  kind: string;
  title: string;
  description: string;
  minutes: number;
  actual_minutes: number;
  status: 'pending' | 'done' | 'skipped';
  revision: number;
  action: Action;
}
export interface Day {
  id: string;
  study_date: string;
  timezone: string;
  revision: number;
  budget_minutes: number;
  planned_minutes: number;
  actual_minutes: number;
  completed_count: number;
  reported_done_minutes: number;
  items: Item[];
  warnings: string[];
  disclaimer: string;
}
export interface Preferences {
  daily_minutes: number;
  path_id: string | null;
  revision: number;
}
export interface WeekPreferences {
  weekday_minutes: number[];
  revision: number;
}
export interface WeekDay {
  date: string;
  weekday: number;
  budget_minutes: number;
  rest_day: boolean;
  planned_minutes: number;
  actual_minutes: number;
  completed_count: number;
  task_count: number;
  forecast_reviews: number;
  forecast_overdue: number;
}
export interface Week {
  id: string;
  week_start: string;
  timezone: string;
  revision: number;
  planned_minutes: number;
  actual_minutes: number;
  budget_minutes: number;
  forecast_reviews: number;
  unscheduled_reviews: number;
  days: WeekDay[];
  warnings: string[];
  disclaimer: string;
}
export interface Focus {
  id: string;
  mode: 'focus' | 'break';
  status: 'running' | 'paused' | 'finished' | 'cancelled';
  title: string;
  duration_seconds: number;
  elapsed_seconds: number;
  remaining_seconds: number;
  revision: number;
  server_now: string;
  created_at: string;
}
export interface FocusAnalytics {
  week_start: string;
  timezone: string;
  measured_minutes: number;
  self_reported_minutes: number;
  planned_minutes: number;
  active_days: number;
  disclaimer: string;
  days: { date: string; measured_minutes: number; self_reported_minutes: number; planned_minutes: number }[];
}
export interface HabitCounts {
  watched_seconds: number;
  lessons: number;
  quizzes: number;
  reviews: number;
}
export interface Habits {
  day: string;
  today: HabitCounts & { goal_met: boolean };
  week: HabitCounts & { active_days: number };
  streak: number;
  best_streak: number;
  preferences: { goal: 'minutes' | 'lesson'; timezone: string; reminder_email: boolean; initialized: boolean };
  email_available: boolean;
  reminder_delivery_available: boolean;
  timezone_anchored: boolean;
}
export interface Recall {
  quality: number;
  course: string;
  question: string;
  date: string;
}
export interface Insights {
  due_count: number;
  total_cards: number;
  reviews_today: number;
  streak_days: number;
  mastery_signal_percent: number | null;
  mastery_basis: string;
  period: string;
  weekly_reviews: { date: string; count: number }[];
  weak_areas: Recall[];
  history: Recall[];
}
export function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid planning response.');
  return v as Record<string, unknown>;
}
export function str(v: unknown): string {
  if (typeof v !== 'string') throw new Error('Invalid planning text.');
  return v;
}
export function num(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('Invalid planning number.');
  return v;
}
export function integer(v: unknown): number {
  const n = num(v);
  if (!Number.isSafeInteger(n)) throw new Error('Invalid planning revision/count.');
  return n;
}
export function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Error('Invalid planning flag.');
  return v;
}
export function array<T>(v: unknown, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new Error('Invalid planning list.');
  return v.map(parse);
}
function one<T extends string>(v: unknown, choices: readonly T[]): T {
  const s = str(v);
  if (!choices.includes(s as T)) throw new Error('Invalid planning state.');
  return s as T;
}
function date(v: unknown): string {
  const s = str(v);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(Date.parse(`${s}T12:00:00Z`)) ||
    new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) !== s
  )
    throw new Error('Invalid planning date.');
  return s;
}
function instant(v: unknown): string {
  const s = str(v);
  if (!Number.isFinite(Date.parse(s))) throw new Error('Invalid planning timestamp.');
  return s;
}
export function action(v: unknown): Action {
  const r = object(v);
  const a: Action = { view: str(r.view) };
  for (const k of ['lesson_id', 'path_id', 'step_id', 'lab_slug'] as const) if (r[k] !== undefined) a[k] = str(r[k]);
  if (r.position !== undefined) a.position = num(r.position);
  if (r.review_card_ids !== undefined) a.review_card_ids = array(r.review_card_ids, str);
  return a;
}
export function item(v: unknown): Item {
  const r = object(v);
  return {
    id: str(r.id),
    kind: str(r.kind),
    title: str(r.title),
    description: str(r.description),
    minutes: integer(r.minutes),
    actual_minutes: integer(r.actual_minutes),
    status: one(r.status, ['pending', 'done', 'skipped']),
    revision: integer(r.revision),
    action: action(r.action),
  };
}
export function day(v: unknown): Day {
  const r = object(v);
  return {
    id: str(r.id),
    study_date: date(r.study_date),
    timezone: str(r.timezone),
    revision: integer(r.revision),
    budget_minutes: integer(r.budget_minutes),
    planned_minutes: integer(r.planned_minutes),
    actual_minutes: integer(r.actual_minutes),
    completed_count: integer(r.completed_count),
    reported_done_minutes: integer(r.reported_done_minutes),
    items: array(r.items, item),
    warnings: array(r.warnings, str),
    disclaimer: str(r.disclaimer),
  };
}
export function preferences(v: unknown): Preferences {
  const r = object(v);
  const minutes = integer(r.daily_minutes);
  if (minutes < 15 || minutes > 180) throw new Error('Invalid daily budget.');
  return { daily_minutes: minutes, path_id: r.path_id === null ? null : str(r.path_id), revision: integer(r.revision) };
}
export function weekPreferences(v: unknown): WeekPreferences {
  const r = object(v);
  const a = array(r.weekday_minutes, integer);
  if (a.length !== 7 || a.some(n => n !== 0 && (n < 15 || n > 180)) || !a.some(Boolean))
    throw new Error('Invalid weekly budgets.');
  return { weekday_minutes: a, revision: integer(r.revision) };
}
export function week(v: unknown): Week {
  const r = object(v);
  const days = array(r.days, x => {
    const d = object(x);
    return {
      date: date(d.date),
      weekday: integer(d.weekday),
      budget_minutes: integer(d.budget_minutes),
      rest_day: bool(d.rest_day),
      planned_minutes: integer(d.planned_minutes),
      actual_minutes: integer(d.actual_minutes),
      completed_count: integer(d.completed_count),
      task_count: integer(d.task_count),
      forecast_reviews: integer(d.forecast_reviews),
      forecast_overdue: integer(d.forecast_overdue),
    };
  });
  if (days.length !== 7) throw new Error('Invalid weekly calendar.');
  return {
    id: str(r.id),
    week_start: date(r.week_start),
    timezone: str(r.timezone),
    revision: integer(r.revision),
    planned_minutes: integer(r.planned_minutes),
    actual_minutes: integer(r.actual_minutes),
    budget_minutes: integer(r.budget_minutes),
    forecast_reviews: integer(r.forecast_reviews),
    unscheduled_reviews: integer(r.unscheduled_reviews),
    days,
    warnings: array(r.warnings, str),
    disclaimer: str(r.disclaimer),
  };
}
export function focus(v: unknown): Focus {
  const r = object(v);
  const f: Focus = {
    id: str(r.id),
    mode: one(r.mode, ['focus', 'break']),
    status: one(r.status, ['running', 'paused', 'finished', 'cancelled']),
    title: str(r.title),
    duration_seconds: integer(r.duration_seconds),
    elapsed_seconds: num(r.elapsed_seconds),
    remaining_seconds: num(r.remaining_seconds),
    revision: integer(r.revision),
    server_now: instant(r.server_now),
    created_at: instant(r.created_at),
  };
  if (
    f.duration_seconds < 60 ||
    f.duration_seconds > 7200 ||
    f.elapsed_seconds > f.duration_seconds ||
    f.remaining_seconds > f.duration_seconds
  )
    throw new Error('Invalid focus duration.');
  return f;
}
export function active(v: unknown): Focus | null {
  const r = object(v);
  instant(r.server_now);
  return r.session === null ? null : focus(r.session);
}
export function focusHistory(v: unknown): { sessions: Focus[]; next_cursor: string } {
  const r = object(v);
  return { sessions: array(r.sessions, focus), next_cursor: str(r.next_cursor) };
}
export function analytics(v: unknown): FocusAnalytics {
  const r = object(v);
  return {
    week_start: date(r.week_start),
    timezone: str(r.timezone),
    measured_minutes: num(r.measured_minutes),
    self_reported_minutes: integer(r.self_reported_minutes),
    planned_minutes: integer(r.planned_minutes),
    active_days: integer(r.active_days),
    disclaimer: str(r.disclaimer),
    days: array(r.days, x => {
      const d = object(x);
      return {
        date: date(d.date),
        measured_minutes: num(d.measured_minutes),
        self_reported_minutes: integer(d.self_reported_minutes),
        planned_minutes: integer(d.planned_minutes),
      };
    }),
  };
}
function counts(v: unknown): HabitCounts {
  const r = object(v);
  return {
    watched_seconds: num(r.watched_seconds),
    lessons: integer(r.lessons),
    quizzes: integer(r.quizzes),
    reviews: integer(r.reviews),
  };
}
export function habits(v: unknown): Habits {
  const r = object(v),
    t = object(r.today),
    w = object(r.week),
    p = object(r.preferences);
  return {
    day: date(r.day),
    today: { ...counts(t), goal_met: bool(t.goal_met) },
    week: { ...counts(w), active_days: integer(w.active_days) },
    streak: integer(r.streak),
    best_streak: integer(r.best_streak),
    preferences: {
      goal: one(p.goal, ['minutes', 'lesson']),
      timezone: str(p.timezone),
      reminder_email: bool(p.reminder_email),
      initialized: bool(p.initialized),
    },
    email_available: bool(r.email_available),
    reminder_delivery_available: bool(r.reminder_delivery_available),
    timezone_anchored: bool(r.timezone_anchored),
  };
}
function recall(v: unknown): Recall {
  const r = object(v);
  const q = integer(r.quality);
  if (q > 5) throw new Error('Invalid recall quality.');
  return { quality: q, course: str(r.course), question: str(r.question), date: date(r.date) };
}
export function insights(v: unknown): Insights {
  const r = object(v);
  const signal = r.mastery_signal_percent === null ? null : integer(r.mastery_signal_percent);
  if (signal !== null && signal > 100) throw new Error('Invalid recall signal.');
  return {
    due_count: integer(r.due_count),
    total_cards: integer(r.total_cards),
    reviews_today: integer(r.reviews_today),
    streak_days: integer(r.streak_days),
    mastery_signal_percent: signal,
    mastery_basis: str(r.mastery_basis),
    period: str(r.period),
    weekly_reviews: array(r.weekly_reviews, x => {
      const d = object(x);
      return { date: date(d.date), count: integer(d.count) };
    }),
    weak_areas: array(r.weak_areas, recall),
    history: array(r.history, recall),
  };
}
export function dateInZone(zone: string, at = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  return ['year', 'month', 'day'].map(k => parts.find(p => p.type === k)?.value ?? '').join('-');
}
export function monday(s: string): string {
  date(s);
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export function addDays(s: string, n: number): string {
  date(s);
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function remaining(snapshot: Focus, receivedAt: number, now: number): number {
  return Math.max(
    0,
    snapshot.remaining_seconds - (snapshot.status === 'running' ? Math.max(0, now - receivedAt) / 1000 : 0),
  );
}
