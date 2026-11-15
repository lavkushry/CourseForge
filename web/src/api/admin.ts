import type {
  AdminLearnerReport,
  AdminOverview,
  AdminSystemReport,
  AdminUser,
  AdminUserDetail,
} from '../admin/contracts';
import {
  parseAdminOverview,
  parseAdminSystemReport,
  parseAdminUserDetail,
  parseAdminUsers,
} from '../admin/contracts';
import { ApiError, isRecord } from './errors';
import type { HttpClient } from './http';

export function adminOverview(client: HttpClient, signal?: AbortSignal): Promise<AdminOverview> {
  return client.request('/admin/overview', signal ? { signal } : {}).then(parseAdminOverview);
}

export function adminSystem(client: HttpClient, signal?: AbortSignal): Promise<AdminSystemReport> {
  return client.request('/admin/system', signal ? { signal } : {}).then(parseAdminSystemReport);
}

export function adminUsers(
  client: HttpClient,
  limit = 50,
  cursor = '',
  signal?: AbortSignal,
  q = '',
): Promise<{ users: AdminUser[]; next_cursor: string | null; total?: number }> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  if (q.trim()) query.set('q', q.trim());
  return client.request(`/admin/users?${query}`, signal ? { signal } : {}).then(parseAdminUsers);
}

export function adminLearnerSummaries(
  client: HttpClient,
  limit = 100,
  cursor = '',
  q = '',
  signal?: AbortSignal,
): Promise<{ users: AdminUser[]; next_cursor: string | null; total?: number }> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  if (q.trim()) query.set('q', q.trim());
  return client.request(`/admin/learner-reports?${query}`, signal ? { signal } : {}).then(parseAdminUsers);
}

export function adminUserDetail(client: HttpClient, userId: string, signal?: AbortSignal): Promise<AdminUserDetail> {
  return client
    .request(`/admin/users/${encodeURIComponent(userId)}`, signal ? { signal } : {})
    .then(parseAdminUserDetail);
}

export function adminSetEnrollment(
  client: HttpClient,
  userId: string,
  course: string,
  enrolled: boolean,
  signal?: AbortSignal,
): Promise<{ ok: boolean }> {
  return client.request(`/admin/users/${encodeURIComponent(userId)}/enrollments`, {
    method: 'PUT',
    body: { course, enrolled },
    ...(signal ? { signal } : {}),
  });
}

export function adminUpdateAccount(
  client: HttpClient,
  userId: string,
  patch: { suspended?: boolean; role?: 'student' | 'admin'; current_password?: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean }> {
  return client.request(`/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: patch,
    ...(signal ? { signal } : {}),
  });
}

export function adminSetRole(
  client: HttpClient,
  userId: string,
  role: 'student' | 'admin',
  currentPassword: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean }> {
  return client.request(`/admin/users/${encodeURIComponent(userId)}/role`, {
    method: 'PUT',
    body: { role, current_password: currentPassword },
    ...(signal ? { signal } : {}),
  });
}

export function adminRevokeSessions(
  client: HttpClient,
  userId: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean }> {
  return client.request(`/admin/users/${encodeURIComponent(userId)}/sessions`, {
    method: 'DELETE',
    ...(signal ? { signal } : {}),
  });
}

export function adminIssueAccountLink(
  client: HttpClient,
  userId: string,
  signal?: AbortSignal,
): Promise<{ account_url: string; expires_at: string; kind: string }> {
  return client.request(`/admin/users/${encodeURIComponent(userId)}/account-link`, {
    method: 'POST',
    body: {},
    ...(signal ? { signal } : {}),
  });
}

export function adminInviteStudent(
  client: HttpClient,
  name: string,
  email: string,
  course = '',
  signal?: AbortSignal,
): Promise<{ user_id: string; activation_url: string; expires_at: string }> {
  return client.request('/admin/invitations', {
    method: 'POST',
    body: { name, email, ...(course ? { course } : {}) },
    ...(signal ? { signal } : {}),
  });
}

export function adminLearnerReport(
  client: HttpClient,
  userId: string,
  signal?: AbortSignal,
): Promise<AdminLearnerReport> {
  return client.request(`/admin/users/${encodeURIComponent(userId)}/learning-report`, signal ? { signal } : {});
}

export function adminLearnerReportSection(
  client: HttpClient,
  userId: string,
  section: string,
  limit = 50,
  signal?: AbortSignal,
): Promise<{ section: string; items: Array<Record<string, unknown>>; next_cursor: string }> {
  const query = new URLSearchParams({ limit: String(limit) });
  return client.request(
    `/admin/users/${encodeURIComponent(userId)}/reports/${encodeURIComponent(section)}?${query}`,
    signal ? { signal } : {},
  );
}

export function adminAuditLog(
  client: HttpClient,
  limit = 50,
  signal?: AbortSignal,
): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string }> {
  const query = new URLSearchParams({ limit: String(limit) });
  return client.request(`/admin/audit?${query}`, signal ? { signal } : {});
}

export function adminAccessEvents(
  client: HttpClient,
  userId = '',
  limit = 50,
  signal?: AbortSignal,
): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string }> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (userId) query.set('user_id', userId);
  return client.request(`/admin/access-events?${query}`, signal ? { signal } : {});
}

export function adminRetentionCurve(
  client: HttpClient,
  lessonId?: string,
  signal?: AbortSignal,
): Promise<{
  lesson_id: string;
  lesson_title: string;
  duration_seconds: number;
  total_sessions: number;
  completion_rate: number;
  points: Array<{ second: number; percentage: number; replays: number }>;
  peak_moments: Array<{ second: number; label: string }>;
}> {
  const q = lessonId ? `?lesson_id=${encodeURIComponent(lessonId)}` : '';
  return client.request(`/admin/analytics/retention${q}`, signal ? { signal } : {});
}

export type AdminPlaybackSession = {
  id: string;
  user_id?: string | undefined;
  name?: string | undefined;
  email?: string | undefined;
  lesson_id?: string | undefined;
  title?: string | undefined;
  device?: string | undefined;
  ip?: string | undefined;
  device_basis?: string | undefined;
  snapshot_at?: string | undefined;
  snapshot_truncated?: boolean | undefined;
  live?: boolean | undefined;
  watched_seconds?: number | undefined;
};

export type AdminPlaybackReport = {
  sessions: AdminPlaybackSession[];
  total: number;
  disclaimer?: string | undefined;
};

export async function adminPlaybackReport(
  client: HttpClient,
  opts: { userId?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<AdminPlaybackReport> {
  const query = new URLSearchParams();
  if (opts.userId) query.set('user_id', opts.userId);
  if (opts.limit) query.set('limit', String(opts.limit));
  const q = query.toString() ? `?${query}` : '';
  const raw = await client.request(`/admin/playback${q}`, opts.signal ? { signal: opts.signal } : {});
  if (!isRecord(raw)) {
    return { sessions: [], total: 0 };
  }
  const sessions = Array.isArray(raw.sessions)
    ? (raw.sessions as unknown[]).filter(isRecord).map(s => ({
        id: String(s.id || ''),
        user_id: typeof s.user_id === 'string' ? s.user_id : undefined,
        name: typeof s.name === 'string' ? s.name : undefined,
        email: typeof s.email === 'string' ? s.email : undefined,
        lesson_id: typeof s.lesson_id === 'string' ? s.lesson_id : undefined,
        title: typeof s.title === 'string' ? s.title : undefined,
        device: typeof s.device === 'string' ? s.device : undefined,
        ip: typeof s.ip === 'string' ? s.ip : undefined,
        device_basis: typeof s.device_basis === 'string' ? s.device_basis : undefined,
        snapshot_at: typeof s.snapshot_at === 'string' ? s.snapshot_at : undefined,
        snapshot_truncated: typeof s.snapshot_truncated === 'boolean' ? s.snapshot_truncated : undefined,
        live: typeof s.live === 'boolean' ? s.live : undefined,
        watched_seconds: typeof s.watched_seconds === 'number' ? s.watched_seconds : undefined,
      }))
    : [];
  return {
    sessions,
    total: typeof raw.total === 'number' ? raw.total : sessions.length,
    disclaimer: typeof raw.disclaimer === 'string' ? raw.disclaimer : undefined,
  };
}

export async function exportReport(
  client: HttpClient & { rawFetch(path: string, init?: RequestInit): Promise<Response> },
  type: 'player-activity' | 'playback',
  userId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const query = new URLSearchParams();
  if (userId) query.set('user_id', userId);
  const qStr = query.toString() ? `?${query.toString()}` : '';
  const res = await client.rawFetch(`/api/v1/admin/${type}/export${qStr}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'text/csv' },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const errJson: unknown = await res.json().catch(() => null);
    const msg =
      isRecord(errJson) && typeof errJson.detail === 'string'
        ? errJson.detail
        : isRecord(errJson) && isRecord(errJson.error) && typeof errJson.error.message === 'string'
          ? errJson.error.message
          : `Export failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return await res.text();
}
