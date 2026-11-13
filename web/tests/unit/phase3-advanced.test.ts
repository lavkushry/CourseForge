import { describe, expect, it } from 'vitest';
import { parseTutorAsk } from '../../src/api/ai';
import { parseLabSession, parseLabsCatalog } from '../../src/api/labs';
import { labsIsolationCopy, labsRunDisabled, labsUnavailableBanner } from '../../src/labs/status';
import {
  isFixtureCourseId,
  realCourseIds,
  stepUnlocked,
  unmetPrerequisiteTitles,
} from '../../src/paths/status';
import type { LearningPath, PathStep } from '../../src/paths/contracts';
import { reviewsEmptyCopy, reviewsLoadFailureCopy } from '../../src/reviews/status';
import { tutorIsReady, tutorUnavailableCopy } from '../../src/tutor/status';
import { remaining } from '../../src/planning/contracts';

function step(partial: Partial<PathStep> & { id: string; title: string }): PathStep {
  return {
    objectives: [],
    sources: [],
    prerequisites: [],
    completed: false,
    ...partial,
  };
}

function path(steps: PathStep[]): LearningPath {
  return {
    id: 'path-1',
    goal: 'Learn systems',
    course_ids: ['course-a'],
    steps,
    provenance: 'manual',
    revision: 1,
    completed_steps: steps.filter(s => s.completed).length,
    completion_percent: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('Phase 3 planning focus honesty', () => {
  it('counts down only while the focus session is running', () => {
    const snapshot = {
      id: 'f1',
      mode: 'focus' as const,
      status: 'running' as const,
      title: 'Study',
      duration_seconds: 60,
      elapsed_seconds: 10,
      remaining_seconds: 50,
      revision: 1,
      server_now: '2026-10-13T12:00:00Z',
      created_at: '2026-10-13T11:59:50Z',
    };
    expect(remaining(snapshot, 1000, 6000)).toBe(45);
    expect(remaining({ ...snapshot, status: 'paused' }, 1000, 6000)).toBe(50);
  });
});

describe('Phase 3 review deck honesty', () => {
  it('keeps empty due queues distinct from load failures', () => {
    expect(reviewsEmptyCopy(0).title).toMatch(/No flashcards due/i);
    expect(reviewsEmptyCopy(3).description).toMatch(/Reviewed 3/);
    expect(reviewsLoadFailureCopy('boom').title).toMatch(/Could not load/);
  });
});

describe('Phase 3 tutor honesty', () => {
  it('disables ask when Ollama is offline and never invents citations', () => {
    expect(tutorIsReady({ ollama_online: false, pgvector_active: false, transcript_chunks: 0 })).toBe(false);
    expect(tutorUnavailableCopy({ ollama_online: false, pgvector_active: false, transcript_chunks: 12 }).description).toMatch(
      /never invented/i,
    );
    const parsed = parseTutorAsk({
      answer: 'Use measured timestamps.',
      mode: 'explain',
      citations: [
        {
          chunk_id: 'c1',
          lesson_id: 'lesson-1',
          lesson_title: 'Intro',
          start_seconds: 12,
          end_seconds: 40,
          text: 'clip',
        },
        { chunk_id: 'bad', lesson_title: 'Missing lesson', start_seconds: 1 },
        { lesson_id: 'lesson-2', start_seconds: -1 },
      ],
    });
    expect(parsed.citations).toHaveLength(1);
    expect(parsed.citations[0]?.lesson_id).toBe('lesson-1');
    expect(() => parseTutorAsk({ answer: '', citations: [] })).toThrow();
  });
});

describe('Phase 3 labs honesty', () => {
  it('disables run when graders are offline and documents Docker isolation', () => {
    expect(labsRunDisabled(false)).toBe(true);
    expect(labsUnavailableBanner(false, false)).toMatch(/Docker graders/i);
    expect(labsIsolationCopy()).toMatch(/no network/i);
    const session = parseLabSession({
      session_id: 's1',
      slug: 'sql-customer-revenue',
      filename: 'solution.sql',
      content: 'SELECT 1',
      title: 'SQL',
      objective: 'Agg',
      tip: '',
      type: 'sql',
      category: 'SQL',
      level: 'Intermediate',
      status: 'started',
      revision: 1,
      content_hash: 'abc',
      grading_available: true,
      result: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    expect(session.session_id).toBe('s1');
    expect(parseLabsCatalog({ labs: [], grading_available: true, kind_available: false }).grading_available).toBe(
      true,
    );
  });
});

describe('Phase 3 roadmaps prerequisites', () => {
  it('locks steps until measured prerequisites are complete and rejects fixtures', () => {
    const a = step({ id: 'a', title: 'Foundations', completed: false });
    const b = step({ id: 'b', title: 'Advanced', prerequisites: ['a'], completed: false });
    const p = path([a, b]);
    expect(stepUnlocked(p, a)).toBe(true);
    expect(stepUnlocked(p, b)).toBe(false);
    expect(unmetPrerequisiteTitles(p, b)).toEqual(['Foundations']);
    a.completed = true;
    expect(stepUnlocked(p, b)).toBe(true);
    expect(isFixtureCourseId('fixture-course')).toBe(true);
    expect(realCourseIds(['course-a', 'fixture-course', ''])).toEqual(['course-a']);
  });
});
