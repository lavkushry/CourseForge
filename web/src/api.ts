import type {
  AuthResponse, ClaimResponse, Course, HistoryItem, Lesson, Note, PlaybackSession, PlaybackTransport,
  PlayerPreferences, Progress, Pulse, PulseAck,
} from './contracts';
import { parseContinued, parseSaved } from './discovery/contracts';
import { parseAuth, parseClaim, parseCourseDetail, parseCourses, parseLessonDetail, parseNote, parseNotes, parsePlaybackSession, parsePreferences, parseProgress, parsePulseAck } from './validation';
import { parseCertificateResponse, parseVerification } from './certificates/contracts';
import type { CertificateResponse, VerificationResult } from './certificates/contracts';
import { parseLearningPaths, parsePath } from './paths/contracts';
import type { LearningPath } from './paths/contracts';
import { parseAdminOverview, parseAdminUsers, parseAdminUserDetail } from './admin/contracts';
import type { AdminOverview, AdminUser, AdminUserDetail, AdminLearnerReport } from './admin/contracts';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = '',
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get terminal(): boolean {
    return [400, 401, 403, 404, 409, 410, 422].includes(this.status);
  }
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not complete.';
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | undefined;
  body?: unknown;
  signal?: AbortSignal | undefined;
  keepalive?: boolean | undefined;
  idempotencyKey?: string | undefined;
}

// Every application call uses cookie authentication. Provider credentials and
// provider URLs are deliberately absent from this interface.
export class ApiClient implements PlaybackTransport {
  private csrf = '';

  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = this.csrf;
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    try {
      const response = await this.fetcher(`/api/v1${path}`, {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        headers,
        signal: controller.signal,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        ...(options.keepalive !== undefined ? { keepalive: options.keepalive } : {}),
      });
      if (!response.ok) {
        const data: unknown = await response.json().catch(() => null);
        const envelope = isRecord(data) && isRecord(data.error) ? data.error : null;
        const detail = isRecord(data) && typeof data.detail === 'string' ? data.detail
          : envelope && typeof envelope.message === 'string' ? envelope.message : `Request failed (${response.status}).`;
        const code = isRecord(data) && typeof data.code === 'string' ? data.code
          : envelope && typeof envelope.code === 'string' ? envelope.code : '';
        const retry = response.headers.get('Retry-After');
        const retryAfterMs = retry ? Math.min(30_000, Math.max(0, Number(retry) * 1000 || Date.parse(retry) - Date.now())) : 0;
        throw new ApiError(detail, response.status, code, retryAfterMs);
      }
      if (response.status === 204 || response.headers.get('Content-Length') === '0') return undefined as T;
      return await response.json() as T;
    } catch (error) {
      if (isAbort(error) && !options.signal?.aborted) {
        throw new ApiError('Request timed out.', 504);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  async login(email: string, password: string, signal?: AbortSignal): Promise<AuthResponse> {
    const auth = await this.request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
      ...(signal ? { signal } : {}),
    }).then(parseAuth);
    this.setAuth(auth);
    return auth;
  }

  async register(name: string, email: string, password: string, signal?: AbortSignal): Promise<AuthResponse> {
    const auth = await this.request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: { name, email, password },
      ...(signal ? { signal } : {}),
    }).then(parseAuth);
    this.setAuth(auth);
    return auth;
  }

  async me(signal?: AbortSignal): Promise<AuthResponse> {
    const auth = await this.request<AuthResponse>('/auth/me', signal ? { signal } : {}).then(parseAuth);
    this.setAuth(auth);
    return auth;
  }

  async logout(): Promise<void> {
    await this.request<void>('/auth/logout', { method: 'POST', body: {} });
    this.csrf = '';
  }

  private setAuth(auth: AuthResponse): void {
    if (!auth?.user?.id || typeof auth.csrf_token !== 'string') throw new ApiError('Invalid sign-in response.', 502);
    this.csrf = auth.csrf_token;
  }

  courses(cursor = '', signal?: AbortSignal, search = ''): Promise<{ courses: Course[]; next_cursor?: string | null }> {
    const query = new URLSearchParams({ limit: '50' });
    if (cursor) query.set('cursor', cursor);
    if (search) query.set('q', search);
    return this.request(`/public/courses?${query}`, signal ? { signal } : {}).then(parseCourses);
  }


  history(cursor = '', signal?: AbortSignal): Promise<{ history: HistoryItem[]; next_cursor?: string | null }> {
    const query = new URLSearchParams({ limit: '30' });
    if (cursor) query.set('cursor', cursor);
    return this.request(`/streaming/history?${query}`, signal ? { signal } : {});
  }

  clearHistory(signal?: AbortSignal): Promise<void> {
    return this.request('/streaming/history/clear', { method: 'POST', body: {}, ...(signal ? { signal } : {}) });
  }

  savedItems(cursor = '', signal?: AbortSignal) {
    const query = new URLSearchParams({ limit: '24' });
    if (cursor) query.set('cursor', cursor);
    return this.request(`/streaming/my-list?${query}`, signal ? { signal } : {}).then(parseSaved);
  }

  continueLearning(signal?: AbortSignal) {
    return this.request('/streaming/continue-watching', signal ? { signal } : {}).then(parseContinued);
  }

  saveCourse(id: string, signal?: AbortSignal): Promise<void> {
    return this.request('/streaming/my-list', { method: 'POST', body: { item_type: 'course', item_id: id }, ...(signal ? { signal } : {}) });
  }

  removeSaved(type: 'course' | 'lecture', id: string, signal?: AbortSignal): Promise<void> {
    return this.request(`/streaming/my-list/${type}/${encodeURIComponent(id)}`, { method: 'DELETE', ...(signal ? { signal } : {}) });
  }

  course(id: string, signal?: AbortSignal, cursor = ''): Promise<{ course: Course; lessons: Lesson[]; next_cursor?: string | null; resume_lesson_id?: string | null }> {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    return this.request(`/courses/${encodeURIComponent(id)}?${query}`, signal ? { signal } : {}).then(parseCourseDetail);
  }

  publicCourse(id: string, signal?: AbortSignal, cursor = ''): Promise<{ course: Course; lessons: Lesson[]; next_cursor?: string | null; resume_lesson_id?: string | null }> {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    return this.request(`/public/courses/${encodeURIComponent(id)}?${query}`, signal ? { signal } : {}).then(parseCourseDetail);
  }

  async courseAll(id: string, signal?: AbortSignal, preview = false): Promise<{ course: Course; lessons: Lesson[]; resume_lesson_id?: string | null }> {
    const fn = preview ? this.publicCourse.bind(this) : this.course.bind(this);
    let res = await fn(id, signal);
    const course = res.course;
    const lessons = [...res.lessons];
    const resume_lesson_id = res.resume_lesson_id ?? null;
    let cursor = res.next_cursor;
    while (cursor && !signal?.aborted) {
      res = await fn(id, signal, cursor);
      lessons.push(...res.lessons);
      cursor = res.next_cursor;
    }
    return { course, lessons, resume_lesson_id };
  }

  enroll(id: string, signal?: AbortSignal): Promise<void> {
    return this.request(`/courses/${encodeURIComponent(id)}/enroll`, { method: 'POST', body: {}, ...(signal ? { signal } : {}) });
  }

  lesson(id: string, signal?: AbortSignal): Promise<{ lesson: Lesson; progress: Progress | null }> {
    return this.request(`/lessons/${encodeURIComponent(id)}`, signal ? { signal } : {}).then(parseLessonDetail);
  }

  progress(id: string, signal?: AbortSignal): Promise<Progress> {
    return this.request(`/lessons/${encodeURIComponent(id)}/progress`, signal ? { signal } : {}).then(parseProgress);
  }

  saveProgress(id: string, position: number, percent: number, revision: number, signal?: AbortSignal): Promise<Progress> {
    return this.request(`/lessons/${encodeURIComponent(id)}/progress`, {
      method: 'PUT', body: { position, percent, expected_revision: revision }, ...(signal ? { signal } : {}),
    }).then(parseProgress);
  }

  notes(id: string, cursor = '', signal?: AbortSignal): Promise<{ notes: Note[]; next_cursor?: string | null }> {
    const query = new URLSearchParams({ limit: '30' });
    if (cursor) query.set('cursor', cursor);
    return this.request(`/lessons/${encodeURIComponent(id)}/notes?${query}`, signal ? { signal } : {}).then(parseNotes);
  }

  createNote(id: string, position: number, content: string, key: string, signal?: AbortSignal): Promise<Note> {
    return this.request(`/lessons/${encodeURIComponent(id)}/notes`, { method: 'POST', body: { position, content }, idempotencyKey: key, ...(signal ? { signal } : {}) }).then(parseNote);
  }

  deleteNote(lessonId: string, noteId: string, signal?: AbortSignal): Promise<void> {
    return this.request(`/lessons/${encodeURIComponent(lessonId)}/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE', ...(signal ? { signal } : {}) });
  }

  create(lessonId: string, takeOver: boolean, startPosition: number | undefined, signal: AbortSignal): Promise<PlaybackSession> {
    return this.request('/playback/sessions', {
      method: 'POST', signal,
      body: { lesson_id: lessonId, take_over: takeOver, ...(startPosition !== undefined ? { start_position: startPosition } : {}) },
    }).then(parsePlaybackSession);
  }

  pulse(sessionId: string, pulse: Pulse, signal: AbortSignal): Promise<PulseAck> {
    return this.request(`/playback/sessions/${encodeURIComponent(sessionId)}/pulse`, { method: 'POST', body: pulse, signal }).then(parsePulseAck);
  }

  async release(sessionId: string, options: { keepalive?: boolean } = {}): Promise<void> {
    await this.request(`/playback/sessions/${encodeURIComponent(sessionId)}/release`, { method: 'POST', body: {}, ...options });
  }

  claim(sessionId: string, takeOver: boolean, signal: AbortSignal): Promise<ClaimResponse> {
    return this.request(`/playback/sessions/${encodeURIComponent(sessionId)}/claim`, { method: 'POST', body: { take_over: takeOver }, signal }).then(parseClaim);
  }

  preferences(signal: AbortSignal): Promise<PlayerPreferences> {
    return this.request('/player/preferences', signal ? { signal } : {}).then(parsePreferences);
  }

  savePreferences(preferences: PlayerPreferences, signal: AbortSignal): Promise<PlayerPreferences> {
    return this.request('/player/preferences', { method: 'PUT', body: preferences, signal }).then(parsePreferences);
  }

  // Certificate endpoints
  certificateStatus(courseId: string, signal?: AbortSignal): Promise<CertificateResponse> {
    return this.request(`/courses/${encodeURIComponent(courseId)}/certificate`, signal ? { signal } : {}).then(parseCertificateResponse);
  }

  issueCertificate(courseId: string, signal?: AbortSignal): Promise<CertificateResponse> {
    return this.request(`/courses/${encodeURIComponent(courseId)}/certificate`, {
      method: 'POST',
      body: {},
      idempotencyKey: crypto.randomUUID(),
      ...(signal ? { signal } : {}),
    }).then(parseCertificateResponse);
  }

  verifyCertificate(code: string, signal?: AbortSignal): Promise<VerificationResult> {
    return this.request(`/certificates/verify/${encodeURIComponent(code)}`, signal ? { signal } : {}).then(parseVerification);
  }

  // Learning Paths endpoints
  learningPaths(cursor = '', signal?: AbortSignal): Promise<{ paths: LearningPath[]; next_cursor: string | null }> {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor) query.set('cursor', cursor);
    return this.request(`/learning-paths?${query}`, signal ? { signal } : {}).then(parseLearningPaths);
  }

  learningPath(id: string, signal?: AbortSignal): Promise<LearningPath> {
    return this.request(`/learning-paths/${encodeURIComponent(id)}`, signal ? { signal } : {}).then(parsePath);
  }

  createLearningPath(goal: string, courseIds: string[], weeks: number, signal?: AbortSignal): Promise<LearningPath> {
    return this.request('/learning-paths', {
      method: 'POST',
      body: { goal, course_ids: courseIds, target_weeks: weeks, expected_revision: 0 },
      idempotencyKey: crypto.randomUUID(),
      ...(signal ? { signal } : {}),
    }).then(parsePath);
  }

  completeStep(pathId: string, stepId: string, completed: boolean, expectedRevision: number, signal?: AbortSignal): Promise<LearningPath> {
    return this.request(`/learning-paths/${encodeURIComponent(pathId)}/steps/${encodeURIComponent(stepId)}`, {
      method: 'PUT',
      body: { completed, expected_revision: Math.max(1, expectedRevision) },
      idempotencyKey: crypto.randomUUID(),
      ...(signal ? { signal } : {}),
    }).then(parsePath);
  }

  // Admin endpoints
  adminOverview(signal?: AbortSignal): Promise<AdminOverview> {
    return this.request('/admin/overview', signal ? { signal } : {}).then(parseAdminOverview);
  }

  adminUsers(limit = 50, cursor = '', signal?: AbortSignal, q = ''): Promise<{ users: AdminUser[]; next_cursor: string | null; total?: number }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    if (q.trim()) query.set('q', q.trim());
    return this.request(`/admin/users?${query}`, signal ? { signal } : {}).then(parseAdminUsers);
  }

  adminLearnerSummaries(limit = 100, cursor = '', q = '', signal?: AbortSignal): Promise<{ users: AdminUser[]; next_cursor: string | null; total?: number }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    if (q.trim()) query.set('q', q.trim());
    return this.request(`/admin/learner-reports?${query}`, signal ? { signal } : {}).then(parseAdminUsers);
  }

  adminUserDetail(userId: string, signal?: AbortSignal): Promise<AdminUserDetail> {
    return this.request(`/admin/users/${encodeURIComponent(userId)}`, signal ? { signal } : {}).then(parseAdminUserDetail);
  }

  adminSetEnrollment(userId: string, course: string, enrolled: boolean, signal?: AbortSignal): Promise<{ ok: boolean }> {
    return this.request(`/admin/users/${encodeURIComponent(userId)}/enrollments`, {
      method: 'PUT',
      body: { course, enrolled },
      ...(signal ? { signal } : {}),
    });
  }

  adminUpdateAccount(
    userId: string,
    patch: { suspended?: boolean; role?: 'student' | 'admin'; current_password?: string },
    signal?: AbortSignal,
  ): Promise<{ ok: boolean }> {
    return this.request(`/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: patch,
      ...(signal ? { signal } : {}),
    });
  }

  adminSetRole(userId: string, role: 'student' | 'admin', currentPassword: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
    return this.request(`/admin/users/${encodeURIComponent(userId)}/role`, {
      method: 'PUT',
      body: { role, current_password: currentPassword },
      ...(signal ? { signal } : {}),
    });
  }

  adminRevokeSessions(userId: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
    return this.request(`/admin/users/${encodeURIComponent(userId)}/sessions`, {
      method: 'DELETE',
      ...(signal ? { signal } : {}),
    });
  }

  adminIssueAccountLink(userId: string, signal?: AbortSignal): Promise<{ account_url: string; expires_at: string; kind: string }> {
    return this.request(`/admin/users/${encodeURIComponent(userId)}/account-link`, {
      method: 'POST',
      body: {},
      ...(signal ? { signal } : {}),
    });
  }

  adminInviteStudent(name: string, email: string, course = '', signal?: AbortSignal): Promise<{ user_id: string; activation_url: string; expires_at: string }> {
    return this.request('/admin/invitations', {
      method: 'POST',
      body: { name, email, ...(course ? { course } : {}) },
      ...(signal ? { signal } : {}),
    });
  }

  adminLearnerReport(userId: string, signal?: AbortSignal): Promise<AdminLearnerReport> {
    return this.request(`/admin/users/${encodeURIComponent(userId)}/learning-report`, signal ? { signal } : {});
  }

  adminLearnerReportSection(
    userId: string,
    section: string,
    limit = 50,
    signal?: AbortSignal,
  ): Promise<{ section: string; items: Array<Record<string, unknown>>; next_cursor: string }> {
    const query = new URLSearchParams({ limit: String(limit) });
    return this.request(`/admin/users/${encodeURIComponent(userId)}/reports/${encodeURIComponent(section)}?${query}`, signal ? { signal } : {});
  }

  adminAuditLog(limit = 50, signal?: AbortSignal): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string }> {
    const query = new URLSearchParams({ limit: String(limit) });
    return this.request(`/admin/audit?${query}`, signal ? { signal } : {});
  }

  adminAccessEvents(userId = '', limit = 50, signal?: AbortSignal): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (userId) query.set('user_id', userId);
    return this.request(`/admin/access-events?${query}`, signal ? { signal } : {});
  }

  // AI Endpoints
  aiStatus(signal?: AbortSignal): Promise<{
    pgvector_active: boolean;
    vector_dimensions: number;
    embeddings_count: number;
    transcript_chunks: number;
    ollama_online: boolean;
    ollama_embedding_model: string;
    ollama_chat_model: string;
  }> {
    return this.request('/ai/status', signal ? { signal } : {});
  }

  aiAsk(courseId: string, lessonId: string, question: string, mode = 'general', signal?: AbortSignal): Promise<{
    answer: string;
    mode: string;
    citations: Array<{
      chunk_id: string;
      lesson_id: string;
      lesson_title: string;
      start_seconds: number;
      end_seconds: number;
      text: string;
    }>;
  }> {
    return this.request('/ai/tutor/ask', {
      method: 'POST',
      body: { course_id: courseId, lesson_id: lessonId, question, mode },
      ...(signal ? { signal } : {}),
    });
  }

  aiSummary(lessonId: string, signal?: AbortSignal): Promise<{
    lesson_id: string;
    title: string;
    course_id: string;
    summary: string;
  }> {
    return this.request(`/ai/lessons/${encodeURIComponent(lessonId)}/summary`, signal ? { signal } : {});
  }

  getLessonTranscripts(lessonId: string, signal?: AbortSignal): Promise<{
    lesson_id: string;
    title: string;
    count: number;
    chunks: Array<{
      id: string;
      start_seconds: number;
      end_seconds: number;
      text: string;
      kind: string;
    }>;
  }> {
    return this.request(`/ai/lessons/${encodeURIComponent(lessonId)}/transcripts`, signal ? { signal } : {});
  }

  getLessonChapters(lessonId: string, signal?: AbortSignal): Promise<{
    lesson_id: string;
    title: string;
    duration: number;
    chapters: Array<{
      index: number;
      title: string;
      start_seconds: number;
      end_seconds: number;
      summary: string;
    }>;
  }> {
    return this.request(`/ai/lessons/${encodeURIComponent(lessonId)}/chapters`, signal ? { signal } : {});
  }

  classifyVideoSplit(lessonId: string, signal?: AbortSignal): Promise<{
    lesson_id: string;
    title: string;
    chapters: Array<{
      index: number;
      title: string;
      start_seconds: number;
      end_seconds: number;
      summary: string;
    }>;
  }> {
    return this.request(`/ai/lessons/${encodeURIComponent(lessonId)}/classify-split`, {
      method: 'POST',
      ...(signal ? { signal } : {}),
    });
  }

  generateAiRoadmap(goal: string, role?: string, signal?: AbortSignal): Promise<{
    id: string;
    goal: string;
    target_role: string;
    estimated_weeks: number;
    steps: Array<{
      step_number: number;
      title: string;
      description: string;
      course_id: string;
      course_title: string;
      estimated_hours: number;
      key_concepts: string[];
    }>;
  }> {
    return this.request('/ai/roadmaps/generate', {
      method: 'POST',
      body: { goal, role: role || '' },
      ...(signal ? { signal } : {}),
    });
  }

  adminRetentionCurve(lessonId?: string, signal?: AbortSignal): Promise<{
    lesson_id: string;
    lesson_title: string;
    duration_seconds: number;
    total_sessions: number;
    completion_rate: number;
    points: Array<{ second: number; percentage: number; replays: number }>;
    peak_moments: Array<{ second: number; label: string }>;
  }> {
    const q = lessonId ? `?lesson_id=${encodeURIComponent(lessonId)}` : '';
    return this.request(`/admin/analytics/retention${q}`, signal ? { signal } : {});
  }

  async exportReport(type: 'player-activity' | 'playback', userId?: string, signal?: AbortSignal): Promise<string> {
    const query = new URLSearchParams();
    if (userId) query.set('user_id', userId);
    const qStr = query.toString() ? `?${query.toString()}` : '';
    const res = await this.fetcher(`/api/v1/admin/${type}/export${qStr}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'text/csv' },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      const msg = (errJson && typeof errJson === 'object' && 'detail' in errJson && typeof errJson.detail === 'string')
        ? errJson.detail
        : (errJson && typeof errJson === 'object' && 'error' in errJson && typeof (errJson as any).error?.message === 'string')
          ? (errJson as any).error.message
          : `Export failed (${res.status})`;
      throw new ApiError(msg, res.status);
    }
    return await res.text();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
