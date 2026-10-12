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
}

export interface AdminLearnerReport {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    activity_seconds: number;
    watched_seconds: number;
    measured_focus_seconds: number;
    created_at: string;
  };
  enrollments: Array<Record<string, unknown>>;
  completed_lessons: Array<Record<string, unknown>>;
  sections?: Record<string, unknown> | undefined;
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

export function parseAdminUsers(value: unknown): { users: AdminUser[]; next_cursor: string | null } {
  if (!value || typeof value !== 'object') throw new ContractError('admin users');
  const d = value as Record<string, unknown>;
  const raw = Array.isArray(d.users) ? d.users : [];
  const users: AdminUser[] = raw.map((u: Record<string, unknown>) => ({
    id: String(u.id || ''),
    email: String(u.email || ''),
    name: String(u.name || ''),
    role: String(u.role || 'student'),
    verified: Boolean(u.verified),
    suspended: Boolean(u.suspended),
    created_at: String(u.created_at || ''),
  }));
  return {
    users,
    next_cursor: typeof d.next_cursor === 'string' && d.next_cursor ? d.next_cursor : null,
  };
}
