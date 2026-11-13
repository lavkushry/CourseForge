import { describe, expect, it } from 'vitest';
import {
  adminAiOfflineLabel,
  adminCatalogCount,
  adminCourseMappingRows,
  adminOverviewEmptyCopy,
  adminOverviewFailureCopy,
  adminSystemUnavailableList,
  adminTaskCountLabel,
} from '../../src/admin/status';
import { parseAdminSystemReport } from '../../src/admin/contracts';
import {
  aiOfflineBanner,
  aiOllamaReady,
  aiRetrievalReady,
  companionUnavailableCopy,
  indexScanUnavailableCopy,
} from '../../src/ai/status';
import { parseAiStatus } from '../../src/api/ai';
import { parseJobList, parsePublicJob } from '../../src/api/jobs';
import {
  jobCanCancel,
  jobCanRetry,
  jobEmptyCopy,
  jobIsTerminal,
  jobProgressLabel,
  jobRetryBlockedCopy,
} from '../../src/jobs/status';

describe('phase 5 admin honesty', () => {
  it('never fabricates a 29-course catalog fallback', () => {
    expect(adminCatalogCount(0, null)).toBe(0);
    expect(
      adminCatalogCount(0, {
        summary: {
          students: 0,
          verified_students: 0,
          suspended_students: 0,
          enrollments: 0,
          completed_lessons: 0,
          activity_seconds: 0,
          watched_seconds: 0,
          measured_focus_seconds: 0,
          courses: 12,
          available_lectures: 0,
          lectures: 0,
          active_sessions: 0,
        },
        recent_activity_sessions: [],
        funnels: [],
        activity_basis: '',
        completion_basis: '',
        server_now: '',
      }),
    ).toBe(12);
    expect(adminOverviewEmptyCopy().description).toContain('fabricated');
    expect(adminOverviewFailureCopy('boom').description).toBe('boom');
  });

  it('parses system reports without inventing capabilities or mapping rows', () => {
    const report = parseAdminSystemReport({
      server_now: '2026-01-01T00:00:00Z',
      capabilities: { registration_mode: 'open', email_configured: null, provider_configured: null },
      tasks: { queued: 2, failed: 1 },
      courses: [{ course_id: 'c1', published: true, lessons: 3, mapped: 2, measured_durations: 1 }],
      course_count: 1,
      course_limit: 100,
      courses_truncated: false,
      pending_invitations: 0,
      audit: [],
      retention: { scheduler_status: 'not_integrated_by_this_module' },
      unavailable: ['external_service_checks', 'engagement_teacher_insights'],
    });
    expect(report.capabilities.email_configured).toBeNull();
    expect(adminSystemUnavailableList(report)).toContain('engagement_teacher_insights');
    expect(adminTaskCountLabel(report.tasks)).toContain('queued: 2');
    expect(adminCourseMappingRows(report.courses)[0]?.mapped).toBe(2);
    expect(adminCourseMappingRows([{ junk: true }])).toEqual([]);
    expect(adminAiOfflineLabel(false, false)).toBe('Offline');
    expect(adminAiOfflineLabel(true, false)).toBe('Online · vectors inactive');
  });
});

describe('phase 5 jobs honesty', () => {
  it('labels progress from measured state and limits retry kinds', () => {
    expect(jobProgressLabel({ state: 'queued', attempt: 1, max_attempts: 3, error_code: null })).toContain(
      'Queued',
    );
    expect(jobProgressLabel({ state: 'failed', attempt: 3, max_attempts: 3, error_code: 'timeout' })).toBe(
      'Failed · timeout',
    );
    expect(jobCanCancel('running')).toBe(true);
    expect(jobCanCancel('completed')).toBe(false);
    expect(jobIsTerminal('completed')).toBe(true);
    expect(jobCanRetry({ kind: 'index', state: 'failed' })).toBe(true);
    expect(jobCanRetry({ kind: 'tutor', state: 'failed' })).toBe(false);
    expect(jobRetryBlockedCopy('tutor')).toContain('product surface');
    expect(jobEmptyCopy().description).toContain('never invented');
  });

  it('parses public jobs without inventing completion', () => {
    const job = parsePublicJob({
      id: 'job_1',
      lesson_id: 'lesson-a',
      kind: 'index',
      resource: 'media_processing',
      state: 'running',
      attempt: 1,
      max_attempts: 3,
      error_code: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:01:00Z',
    });
    expect(job.state).toBe('running');
    expect(parseJobList({ jobs: [job], next_cursor: '' }).jobs).toHaveLength(1);
    expect(() => parsePublicJob({ id: 'x' })).toThrow();
  });
});

describe('phase 5 AI adapter honesty', () => {
  it('surfaces offline Ollama/Qdrant and never invents retrieval readiness', () => {
    expect(aiOllamaReady(null)).toBe(false);
    expect(
      aiRetrievalReady({
        ollama_online: true,
        pgvector_active: false,
        transcript_chunks: 0,
        qdrant_configured: true,
        qdrant_online: false,
      }),
    ).toBe(false);
    const offline = parseAiStatus({
      ollama_online: false,
      pgvector_active: false,
      transcript_chunks: 0,
      embeddings_count: 0,
      vector_dimensions: 0,
      ollama_chat_model: 'llama',
      ollama_embedding_model: 'embed',
      qdrant_configured: true,
      qdrant_online: false,
    });
    expect(aiOfflineBanner(offline)).toContain('Ollama is offline');
    expect(aiOfflineBanner(offline)).toContain('Qdrant is offline');
    expect(companionUnavailableCopy(offline).title).toBe('Companion unavailable');
    expect(indexScanUnavailableCopy(offline).description).toContain('never invented');
    expect(parseAiStatus({ ollama_online: 'yes', pgvector_active: 1 }).ollama_online).toBe(false);
    expect(parseAiStatus({ ollama_online: 'yes', pgvector_active: 1 }).pgvector_active).toBe(false);
  });
});
