import { ContractError } from '../validation';

export interface AdminSummary {
  students: number;
  verified_students: number;
  suspended_students: number;
  enrollments: number;
  completed_lessons: number;
  activity_seconds: number;
  watched_seconds: number;
  measured_focus_seconds: number;
  courses: number;
  available_lectures: number;
  lectures: number;
  active_sessions: number;
}

export interface AdminOverview {
  summary: AdminSummary;
  recent_activity_sessions: Array<Record<string, unknown>>;
  funnels: Array<Record<string, unknown>>;
  activity_basis: string;
  completion_basis: string;
  server_now: string;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  verified: boolean;
  suspended: boolean;
  created_at: string;
  enrollments?: number | undefined;
  completed_lessons?: number | undefined;
  activity_seconds?: number | undefined;
  watched_seconds?: number | undefined;
  measured_focus_seconds?: number | undefined;
  note_count?: number | undefined;
  bookmark_count?: number | undefined;
  quiz_attempts?: number | undefined;
  topic_assessment_attempts?: number | undefined;
  review_attempts?: number | undefined;
  last_seen?: string | null | undefined;
}

export interface AdminUserDetail {
  user: AdminUser;
  enrollments: string[];
}

export interface AdminLearnerReport {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    verified?: boolean;
    suspended?: boolean;
    enrollments?: number;
    completed_lessons?: number;
    activity_seconds: number;
    watched_seconds: number;
    measured_focus_seconds: number;
    note_count?: number;
    bookmark_count?: number;
    quiz_attempts?: number;
    last_seen?: string | null;
    created_at: string;
  };
  enrollments?: Array<Record<string, unknown>>;
  completed_lessons?: Array<Record<string, unknown>>;
  sections?: string[] | Record<string, unknown> | undefined;
}

export interface AdminAuditEntry {
  id: string | number;
  actor: string;
  action: string;
  resource: string;
  created_at: string;
}

export interface AdminSystemReport {
  server_now: string;
  database: Record<string, unknown>;
  jobs: Record<string, unknown>;
  capabilities: Record<string, unknown>;
}

export function parseAdminOverview(value: unknown): AdminOverview {
  if (!value || typeof value !== 'object') throw new ContractError('admin overview');
  const d = value as Record<string, unknown>;
  const s = (d.summary || {}) as Record<string, unknown>;
  return {
    summary: {
      students: Number(s.students || 0),
      verified_students: Number(s.verified_students || 0),
      suspended_students: Number(s.suspended_students || 0),
      enrollments: Number(s.enrollments || 0),
      completed_lessons: Number(s.completed_lessons || 0),
      activity_seconds: Number(s.activity_seconds || 0),
      watched_seconds: Number(s.watched_seconds || 0),
      measured_focus_seconds: Number(s.measured_focus_seconds || 0),
      courses: Number(s.courses || 0),
      available_lectures: Number(s.available_lectures || 0),
      lectures: Number(s.lectures || 0),
      active_sessions: Number(s.active_sessions || 0),
    },
    recent_activity_sessions: Array.isArray(d.recent_activity_sessions) ? d.recent_activity_sessions as Array<Record<string, unknown>> : [],
    funnels: Array.isArray(d.funnels) ? d.funnels as Array<Record<string, unknown>> : [],
    activity_basis: String(d.activity_basis || ''),
    completion_basis: String(d.completion_basis || ''),
    server_now: String(d.server_now || ''),
  };
}

export function parseAdminUserItem(u: Record<string, unknown>): AdminUser {
  return {
    id: String(u.id || ''),
    email: String(u.email || ''),
    name: String(u.name || ''),
    role: String(u.role || 'student'),
    verified: Boolean(u.verified),
    suspended: Boolean(u.suspended),
    created_at: String(u.created_at || ''),
    ...(u.enrollments !== undefined ? { enrollments: Number(u.enrollments || 0) } : {}),
    ...(u.completed_lessons !== undefined ? { completed_lessons: Number(u.completed_lessons || 0) } : {}),
    ...(u.activity_seconds !== undefined ? { activity_seconds: Number(u.activity_seconds || 0) } : {}),
    ...(u.watched_seconds !== undefined ? { watched_seconds: Number(u.watched_seconds || 0) } : {}),
    ...(u.measured_focus_seconds !== undefined ? { measured_focus_seconds: Number(u.measured_focus_seconds || 0) } : {}),
    ...(u.note_count !== undefined ? { note_count: Number(u.note_count || 0) } : {}),
    ...(u.bookmark_count !== undefined ? { bookmark_count: Number(u.bookmark_count || 0) } : {}),
    ...(u.quiz_attempts !== undefined ? { quiz_attempts: Number(u.quiz_attempts || 0) } : {}),
    ...(u.topic_assessment_attempts !== undefined ? { topic_assessment_attempts: Number(u.topic_assessment_attempts || 0) } : {}),
    ...(u.review_attempts !== undefined ? { review_attempts: Number(u.review_attempts || 0) } : {}),
    ...(u.last_seen !== undefined ? { last_seen: typeof u.last_seen === 'string' ? u.last_seen : null } : {}),
  };
}

export function parseAdminUsers(value: unknown): { users: AdminUser[]; next_cursor: string | null; total?: number } {
  if (!value || typeof value !== 'object') throw new ContractError('admin users');
  const d = value as Record<string, unknown>;
  const raw = Array.isArray(d.users) ? d.users : [];
  const users: AdminUser[] = raw.map((u: Record<string, unknown>) => parseAdminUserItem(u));
  return {
    users,
    next_cursor: typeof d.next_cursor === 'string' && d.next_cursor ? d.next_cursor : null,
    ...(typeof d.total === 'number' ? { total: d.total } : {}),
  };
}

export function parseAdminUserDetail(value: unknown): AdminUserDetail {
  if (!value || typeof value !== 'object') throw new ContractError('admin user detail');
  const d = value as Record<string, unknown>;
  const u = (d.user && typeof d.user === 'object') ? d.user as Record<string, unknown> : {};
  const enrollments = Array.isArray(d.enrollments) ? d.enrollments.map(String) : [];
  return {
    user: parseAdminUserItem(u),
    enrollments,
  };
}
