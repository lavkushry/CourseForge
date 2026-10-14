import type {
  AuthResponse,
  ClaimResponse,
  Course,
  HistoryItem,
  Lesson,
  Note,
  PlaybackSession,
  PlaybackTransport,
  PlayerPreferences,
  Progress,
  Pulse,
  PulseAck,
} from '../contracts';
import type { CertificateResponse, VerificationResult } from '../certificates/contracts';
import type { LearningPath } from '../paths/contracts';
import type { AdminLearnerReport, AdminOverview, AdminUser, AdminUserDetail } from '../admin/contracts';
import * as adminApi from './admin';
import * as aiApi from './ai';
import * as authApi from './auth';
import * as catalogApi from './catalog';
import * as certificatesApi from './certificates';
import { HttpClient } from './http';
import * as notesApi from './notes';
import * as pathsApi from './paths';
import * as playbackApi from './playback';
import * as streamingApi from './streaming';

export class ApiClient extends HttpClient implements PlaybackTransport {
  setAuth(auth: AuthResponse): void {
    authApi.applyAuth(this, auth);
  }

  clearAuth(): void {
    this.clearCsrf();
  }

  setCsrfToken(token: string): void {
    this.setCsrf(token);
  }

  rawFetch(path: string, init?: RequestInit): Promise<Response> {
    return this.fetcher(path, init);
  }

  login(email: string, password: string, signal?: AbortSignal): Promise<AuthResponse> {
    return authApi.login(this, email, password, signal);
  }

  register(name: string, email: string, password: string, signal?: AbortSignal): Promise<AuthResponse> {
    return authApi.register(this, name, email, password, signal);
  }

  me(signal?: AbortSignal): Promise<AuthResponse> {
    return authApi.me(this, signal);
  }

  logout(): Promise<void> {
    return authApi.logout(this);
  }

  courses(cursor = '', signal?: AbortSignal, search = ''): Promise<{ courses: Course[]; next_cursor?: string | null }> {
    return catalogApi.courses(this, cursor, signal, search);
  }

  history(cursor = '', signal?: AbortSignal): Promise<{ history: HistoryItem[]; next_cursor?: string | null }> {
    return streamingApi.history(this, cursor, signal);
  }

  clearHistory(signal?: AbortSignal): Promise<void> {
    return streamingApi.clearHistory(this, signal);
  }

  savedItems(cursor = '', signal?: AbortSignal) {
    return streamingApi.savedItems(this, cursor, signal);
  }

  continueLearning(signal?: AbortSignal) {
    return streamingApi.continueLearning(this, signal);
  }

  saveCourse(id: string, signal?: AbortSignal): Promise<void> {
    return streamingApi.saveCourse(this, id, signal);
  }

  removeSaved(type: 'course' | 'lecture', id: string, signal?: AbortSignal): Promise<void> {
    return streamingApi.removeSaved(this, type, id, signal);
  }

  course(
    id: string,
    signal?: AbortSignal,
    cursor = '',
  ): Promise<{ course: Course; lessons: Lesson[]; next_cursor?: string | null; resume_lesson_id?: string | null }> {
    return catalogApi.course(this, id, signal, cursor);
  }

  publicCourse(
    id: string,
    signal?: AbortSignal,
    cursor = '',
  ): Promise<{ course: Course; lessons: Lesson[]; next_cursor?: string | null; resume_lesson_id?: string | null }> {
    return catalogApi.publicCourse(this, id, signal, cursor);
  }

  courseAll(
    id: string,
    signal?: AbortSignal,
    preview = false,
  ): Promise<{ course: Course; lessons: Lesson[]; resume_lesson_id?: string | null }> {
    return catalogApi.courseAll(this, id, signal, preview);
  }

  enroll(id: string, signal?: AbortSignal): Promise<void> {
    return catalogApi.enroll(this, id, signal);
  }

  lesson(id: string, signal?: AbortSignal): Promise<{ lesson: Lesson; progress: Progress | null }> {
    return catalogApi.lesson(this, id, signal);
  }

  progress(id: string, signal?: AbortSignal): Promise<Progress> {
    return catalogApi.progress(this, id, signal);
  }

  saveProgress(
    id: string,
    position: number,
    percent: number,
    revision: number,
    signal?: AbortSignal,
  ): Promise<Progress> {
    return catalogApi.saveProgress(this, id, position, percent, revision, signal);
  }

  notes(id: string, cursor = '', signal?: AbortSignal): Promise<{ notes: Note[]; next_cursor?: string | null }> {
    return notesApi.notes(this, id, cursor, signal);
  }

  createNote(id: string, position: number, content: string, key: string, signal?: AbortSignal): Promise<Note> {
    return notesApi.createNote(this, id, position, content, key, signal);
  }

  deleteNote(lessonId: string, noteId: string, signal?: AbortSignal): Promise<void> {
    return notesApi.deleteNote(this, lessonId, noteId, signal);
  }

  create(
    lessonId: string,
    takeOver: boolean,
    startPosition: number | undefined,
    signal: AbortSignal,
  ): Promise<PlaybackSession> {
    return playbackApi.create(this, lessonId, takeOver, startPosition, signal);
  }

  pulse(sessionId: string, pulse: Pulse, signal: AbortSignal): Promise<PulseAck> {
    return playbackApi.pulse(this, sessionId, pulse, signal);
  }

  release(sessionId: string, options: { keepalive?: boolean } = {}): Promise<void> {
    return playbackApi.release(this, sessionId, options);
  }

  claim(sessionId: string, takeOver: boolean, signal: AbortSignal): Promise<ClaimResponse> {
    return playbackApi.claim(this, sessionId, takeOver, signal);
  }

  preferences(signal: AbortSignal): Promise<PlayerPreferences> {
    return playbackApi.preferences(this, signal);
  }

  savePreferences(preferences: PlayerPreferences, signal: AbortSignal): Promise<PlayerPreferences> {
    return playbackApi.savePreferences(this, preferences, signal);
  }

  certificateStatus(courseId: string, signal?: AbortSignal): Promise<CertificateResponse> {
    return certificatesApi.certificateStatus(this, courseId, signal);
  }

  issueCertificate(courseId: string, signal?: AbortSignal): Promise<CertificateResponse> {
    return certificatesApi.issueCertificate(this, courseId, signal);
  }

  verifyCertificate(code: string, signal?: AbortSignal): Promise<VerificationResult> {
    return certificatesApi.verifyCertificate(this, code, signal);
  }

  learningPaths(
    cursor = '',
    signal?: AbortSignal,
  ): Promise<{ paths: LearningPath[]; next_cursor: string | null }> {
    return pathsApi.learningPaths(this, cursor, signal);
  }

  learningPath(id: string, signal?: AbortSignal): Promise<LearningPath> {
    return pathsApi.learningPath(this, id, signal);
  }

  createLearningPath(
    goal: string,
    courseIds: string[],
    weeks: number,
    signal?: AbortSignal,
  ): Promise<LearningPath> {
    return pathsApi.createLearningPath(this, goal, courseIds, weeks, signal);
  }

  completeStep(
    pathId: string,
    stepId: string,
    completed: boolean,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<LearningPath> {
    return pathsApi.completeStep(this, pathId, stepId, completed, expectedRevision, signal);
  }

  adminOverview(signal?: AbortSignal): Promise<AdminOverview> {
    return adminApi.adminOverview(this, signal);
  }

  adminUsers(
    limit = 50,
    cursor = '',
    signal?: AbortSignal,
    q = '',
  ): Promise<{ users: AdminUser[]; next_cursor: string | null; total?: number }> {
    return adminApi.adminUsers(this, limit, cursor, signal, q);
  }

  adminLearnerSummaries(
    limit = 100,
    cursor = '',
    q = '',
    signal?: AbortSignal,
  ): Promise<{ users: AdminUser[]; next_cursor: string | null; total?: number }> {
    return adminApi.adminLearnerSummaries(this, limit, cursor, q, signal);
  }

  adminUserDetail(userId: string, signal?: AbortSignal): Promise<AdminUserDetail> {
    return adminApi.adminUserDetail(this, userId, signal);
  }

  adminSetEnrollment(
    userId: string,
    course: string,
    enrolled: boolean,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean }> {
    return adminApi.adminSetEnrollment(this, userId, course, enrolled, signal);
  }

  adminUpdateAccount(
    userId: string,
    patch: { suspended?: boolean; role?: 'student' | 'admin'; current_password?: string },
    signal?: AbortSignal,
  ): Promise<{ ok: boolean }> {
    return adminApi.adminUpdateAccount(this, userId, patch, signal);
  }

  adminSetRole(
    userId: string,
    role: 'student' | 'admin',
    currentPassword: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean }> {
    return adminApi.adminSetRole(this, userId, role, currentPassword, signal);
  }

  adminRevokeSessions(userId: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
    return adminApi.adminRevokeSessions(this, userId, signal);
  }

  adminIssueAccountLink(
    userId: string,
    signal?: AbortSignal,
  ): Promise<{ account_url: string; expires_at: string; kind: string }> {
    return adminApi.adminIssueAccountLink(this, userId, signal);
  }

  adminInviteStudent(
    name: string,
    email: string,
    course = '',
    signal?: AbortSignal,
  ): Promise<{ user_id: string; activation_url: string; expires_at: string }> {
    return adminApi.adminInviteStudent(this, name, email, course, signal);
  }

  adminLearnerReport(userId: string, signal?: AbortSignal): Promise<AdminLearnerReport> {
    return adminApi.adminLearnerReport(this, userId, signal);
  }

  adminLearnerReportSection(
    userId: string,
    section: string,
    limit = 50,
    signal?: AbortSignal,
  ): Promise<{ section: string; items: Array<Record<string, unknown>>; next_cursor: string }> {
    return adminApi.adminLearnerReportSection(this, userId, section, limit, signal);
  }

  adminAuditLog(
    limit = 50,
    signal?: AbortSignal,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string }> {
    return adminApi.adminAuditLog(this, limit, signal);
  }

  adminAccessEvents(
    userId = '',
    limit = 50,
    signal?: AbortSignal,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string }> {
    return adminApi.adminAccessEvents(this, userId, limit, signal);
  }

  aiStatus(signal?: AbortSignal) {
    return aiApi.aiStatus(this, signal);
  }

  aiAsk(courseId: string, lessonId: string, question: string, mode = 'general', signal?: AbortSignal) {
    return aiApi.aiAsk(this, courseId, lessonId, question, mode, signal);
  }

  aiSummary(lessonId: string, signal?: AbortSignal) {
    return aiApi.aiSummary(this, lessonId, signal);
  }

  getLessonTranscripts(lessonId: string, signal?: AbortSignal) {
    return aiApi.getLessonTranscripts(this, lessonId, signal);
  }

  getLessonChapters(lessonId: string, signal?: AbortSignal) {
    return aiApi.getLessonChapters(this, lessonId, signal);
  }

  classifyVideoSplit(lessonId: string, signal?: AbortSignal) {
    return aiApi.classifyVideoSplit(this, lessonId, signal);
  }

  generateAiRoadmap(goal: string, role?: string, signal?: AbortSignal) {
    return aiApi.generateAiRoadmap(this, goal, role, signal);
  }

  adminRetentionCurve(lessonId?: string, signal?: AbortSignal) {
    return adminApi.adminRetentionCurve(this, lessonId, signal);
  }

  exportReport(type: 'player-activity' | 'playback', userId?: string, signal?: AbortSignal): Promise<string> {
    return adminApi.exportReport(this, type, userId, signal);
  }
}
