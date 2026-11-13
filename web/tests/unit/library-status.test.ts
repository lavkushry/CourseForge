import { describe, expect, it } from 'vitest';
import type { Course } from '../../src/contracts';
import type { ContinueItem, SavedItem } from '../../src/discovery/contracts';
import {
  completedCourseIds,
  filterLibraryCourses,
  libraryLoadFailureCopy,
  progressByCourse,
  savedCourseIds,
  sortLibraryCourses,
} from '../../src/library/status';

function course(id: string, title = id): Course {
  return { id, title, enrolled: true };
}

function cont(overrides: Partial<ContinueItem> & { course_id: string; id: string }): ContinueItem {
  return {
    title: 'Lecture',
    duration_seconds: 600,
    section_title: 'Module',
    position: 30,
    percent: 10,
    completed: false,
    ...overrides,
  };
}

describe('library status honesty', () => {
  it('keeps load failures distinct from an empty library', () => {
    expect(libraryLoadFailureCopy('Catalog temporarily unavailable.')).toEqual({
      title: 'Could not load your library',
      description: 'Catalog temporarily unavailable.',
    });
  });

  it('classifies progress, completed, and saved from private state only', () => {
    const courses = [course('a'), course('b'), course('c'), course('d')];
    const progress = progressByCourse([
      cont({ id: 'l1', course_id: 'a', percent: 40, completed: false }),
      cont({ id: 'l2', course_id: 'b', percent: 100, completed: true }),
    ]);
    const completed = completedCourseIds([
      { course_id: 'b', completed: true },
      { course_id: 'c', completed: false },
      { course_id: 'd', completed: true },
    ]);
    const saved = savedCourseIds([
      { id: 'c', item_type: 'course', course_id: 'c', title: 'C' },
      { id: 'x', item_type: 'lecture', course_id: 'a', title: 'L' },
    ] as SavedItem[]);

    expect(filterLibraryCourses(courses, 'progress', { progress, completed, saved }).map(c => c.id)).toEqual(['a']);
    expect(filterLibraryCourses(courses, 'completed', { progress, completed, saved }).map(c => c.id).sort()).toEqual([
      'b',
      'd',
    ]);
    expect(filterLibraryCourses(courses, 'saved', { progress, completed, saved }).map(c => c.id)).toEqual(['c']);
  });

  it('does not treat enrolled-only courses as in progress or completed', () => {
    const courses = [course('enrolled-only')];
    const empty = {
      progress: new Map(),
      completed: new Set<string>(),
      saved: new Set<string>(),
    };
    expect(filterLibraryCourses(courses, 'progress', empty)).toEqual([]);
    expect(filterLibraryCourses(courses, 'completed', empty)).toEqual([]);
    expect(filterLibraryCourses(courses, 'all', empty)).toEqual(courses);
  });

  it('sorts by measured progress percent without inventing ranks', () => {
    const courses = [course('low', 'Low'), course('high', 'High'), course('mid', 'Mid')];
    const progress = progressByCourse([
      cont({ id: '1', course_id: 'low', percent: 10 }),
      cont({ id: '2', course_id: 'high', percent: 90 }),
      cont({ id: '3', course_id: 'mid', percent: 40 }),
    ]);
    expect(sortLibraryCourses(courses, 'progress', progress).map(c => c.id)).toEqual(['high', 'mid', 'low']);
  });
});
