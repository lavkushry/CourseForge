import { describe, expect, it } from 'vitest';
import { parseCertificateResponse, parseVerification } from '../../src/certificates/contracts';
import { parseLearningPaths, parsePath } from '../../src/paths/contracts';
import { parseAdminOverview, parseAdminUsers } from '../../src/admin/contracts';

describe('Certificates contracts', () => {
  it('parses issued certificate successfully', () => {
    const raw = {
      issued: true,
      certificate_id: 'cert_12345',
      verification_code: 'CF-2026-ABCD',
      student_name: 'Alice Learner',
      course: 'Go Microservices Architecture',
      completed_at: '2026-10-12T12:00:00Z',
      verify_url: '/verify/CF-2026-ABCD',
    };
    const parsed = parseCertificateResponse(raw);
    expect(parsed.issued).toBe(true);
    if (parsed.issued) {
      expect(parsed.certificate_id).toBe('cert_12345');
      expect(parsed.verification_code).toBe('CF-2026-ABCD');
      expect(parsed.student_name).toBe('Alice Learner');
      expect(parsed.course).toBe('Go Microservices Architecture');
      expect(parsed.verify_url).toBe('/verify/CF-2026-ABCD');
    }
  });

  it('parses certificate readiness in-progress state', () => {
    const raw = {
      issued: false,
      eligible: false,
      reason: 'Complete remaining quizzes to claim certificate',
      total_lessons: 10,
      completed_lessons: 7,
      passed_quizzes: 2,
      remaining_lessons: 3,
      remaining_quizzes: 1,
    };
    const parsed = parseCertificateResponse(raw);
    expect(parsed.issued).toBe(false);
    if (!parsed.issued) {
      expect(parsed.eligible).toBe(false);
      expect(parsed.reason).toBe('Complete remaining quizzes to claim certificate');
      expect(parsed.total_lessons).toBe(10);
      expect(parsed.completed_lessons).toBe(7);
      expect(parsed.passed_quizzes).toBe(2);
    }
  });

  it('parses public verification result', () => {
    const raw = {
      valid: true,
      student_name: 'Bob Builder',
      course: 'Cloud Data Pipeline',
      completed_at: '2026-09-01T00:00:00Z',
      verification_code: 'CF-VAL-99',
      status: 'active',
    };
    const parsed = parseVerification(raw);
    expect(parsed.valid).toBe(true);
    expect(parsed.student_name).toBe('Bob Builder');
    expect(parsed.verification_code).toBe('CF-VAL-99');
  });

  it('rejects malformed certificate payload', () => {
    expect(() => parseCertificateResponse(null)).toThrow();
    expect(() => parseCertificateResponse('invalid')).toThrow();
    expect(() => parseVerification(null)).toThrow();
  });
});

describe('Learning Paths contracts', () => {
  it('parses roadmap definition, revision, and milestone steps', () => {
    const raw = {
      id: 'path_abc',
      goal: 'Master Cloud Native Data Platform',
      course_ids: ['c1', 'c2'],
      provenance: 'manual',
      revision: 4,
      completed_steps: 1,
      completion_percent: 50,
      steps: [
        {
          id: 'step_1',
          title: 'Infrastructure as Code Foundations',
          objectives: ['Deploy terraform state', 'Configure VPC peering'],
          completed: true,
          sources: [
            { lesson_id: 'l_10', course_id: 'c1', start: 120, title: 'Terraform Modules' },
          ],
          prerequisites: [],
        },
        {
          id: 'step_2',
          title: 'PostgreSQL Distributed Storage',
          objectives: ['Partitioning tables'],
          completed: false,
          sources: [],
          prerequisites: ['step_1'],
        },
      ],
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-12T00:00:00Z',
    };
    const parsed = parsePath(raw);
    expect(parsed.id).toBe('path_abc');
    expect(parsed.revision).toBe(4);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0]?.completed).toBe(true);
    expect(parsed.steps[0]?.sources[0]?.title).toBe('Terraform Modules');
    expect(parsed.completion_percent).toBe(50);
  });

  it('parses learning paths collection and cursor with default revision fallback', () => {
    const raw = {
      paths: [
        { id: 'p1', goal: 'Goal 1', course_ids: ['c1'], steps: [], provenance: 'legacy_import', completed_steps: 0, completion_percent: 0, created_at: '', updated_at: '' },
      ],
      next_cursor: 'cursor_xyz',
    };
    const parsed = parseLearningPaths(raw);
    expect(parsed.paths).toHaveLength(1);
    expect(parsed.paths[0]?.provenance).toBe('legacy_import');
    expect(parsed.paths[0]?.revision).toBe(1);
    expect(parsed.next_cursor).toBe('cursor_xyz');
  });

  it('rejects invalid path objects', () => {
    expect(() => parsePath(null)).toThrow();
    expect(() => parseLearningPaths({ paths: 'not-an-array' })).toThrow();
  });
});

describe('Admin Contracts', () => {
  it('parses admin overview summary metrics and recent activity', () => {
    const raw = {
      summary: {
        students: 42,
        verified_students: 40,
        suspended_students: 2,
        enrollments: 120,
        completed_lessons: 350,
        activity_seconds: 72000,
        watched_seconds: 68000,
        measured_focus_seconds: 65000,
        courses: 15,
        available_lectures: 140,
        lectures: 150,
        active_sessions: 5,
      },
      recent_activity_sessions: [
        { name: 'Learner One', email: 'one@example.com', title: 'Intro to Go', activity_seconds: 400, last_active: '2026-10-12T15:00:00Z' },
      ],
      funnels: [
        { title: 'Full Stack Go', enrolled: 50, started: 35 },
      ],
      activity_basis: 'heartbeat_v2',
      completion_basis: 'watch_or_mark',
      server_now: '2026-10-12T18:00:00Z',
    };
    const parsed = parseAdminOverview(raw);
    expect(parsed.summary.students).toBe(42);
    expect(parsed.summary.verified_students).toBe(40);
    expect(parsed.summary.courses).toBe(15);
    expect(parsed.recent_activity_sessions).toHaveLength(1);
    expect(parsed.funnels).toHaveLength(1);
  });

  it('parses admin user directory listing', () => {
    const raw = {
      users: [
        { id: 'u_1', email: 'admin@example.com', name: 'Admin Boss', role: 'admin', verified: true, suspended: false, created_at: '2026-01-01T00:00:00Z' },
        { id: 'u_2', email: 'student@example.com', name: 'Student One', role: 'student', verified: true, suspended: false, created_at: '2026-02-01T00:00:00Z' },
      ],
      next_cursor: null,
    };
    const parsed = parseAdminUsers(raw);
    expect(parsed.users).toHaveLength(2);
    expect(parsed.users[0]?.role).toBe('admin');
    expect(parsed.users[1]?.role).toBe('student');
    expect(parsed.next_cursor).toBeNull();
  });

  it('rejects invalid admin payloads', () => {
    expect(() => parseAdminOverview(null)).toThrow();
    expect(() => parseAdminUsers(null)).toThrow();
  });
});
