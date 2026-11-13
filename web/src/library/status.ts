import type { Course } from '../contracts';
import type { ContinueItem, SavedItem } from '../discovery/contracts';

export type LibraryStatusFilter = 'all' | 'progress' | 'completed' | 'saved';
export type LibrarySortOption = 'recent' | 'title' | 'progress' | 'duration';

export interface CourseProgressSummary {
  percent: number;
  lessonId: string;
  position: number;
  completed: boolean;
}

/** Best continue-watching snapshot per course (highest percent, completed preferred). */
export function progressByCourse(items: ContinueItem[]): Map<string, CourseProgressSummary> {
  const map = new Map<string, CourseProgressSummary>();
  for (const item of items) {
    const prev = map.get(item.course_id);
    const next: CourseProgressSummary = {
      percent: item.percent,
      lessonId: item.id,
      position: item.position,
      completed: item.completed,
    };
    if (!prev) {
      map.set(item.course_id, next);
      continue;
    }
    if (item.completed && !prev.completed) {
      map.set(item.course_id, next);
      continue;
    }
    if (item.completed === prev.completed && item.percent >= prev.percent) {
      map.set(item.course_id, next);
    }
  }
  return map;
}

/** Course IDs marked completed from watch history (only when completed=true). */
export function completedCourseIds(history: Array<{ course_id: string; completed: boolean }>): Set<string> {
  const ids = new Set<string>();
  for (const item of history) {
    if (item.completed) ids.add(item.course_id);
  }
  return ids;
}

export function savedCourseIds(items: SavedItem[]): Set<string> {
  return new Set(items.filter(item => item.item_type === 'course').map(item => item.id));
}

export function filterLibraryCourses(
  courses: Course[],
  filter: LibraryStatusFilter,
  opts: {
    progress: Map<string, CourseProgressSummary>;
    completed: Set<string>;
    saved: Set<string>;
  },
): Course[] {
  switch (filter) {
    case 'all':
      return [...courses];
    case 'progress':
      return courses.filter(c => {
        const p = opts.progress.get(c.id);
        return Boolean(p && !p.completed && !opts.completed.has(c.id));
      });
    case 'completed':
      return courses.filter(c => opts.completed.has(c.id) || opts.progress.get(c.id)?.completed === true);
    case 'saved':
      return courses.filter(c => opts.saved.has(c.id));
    default: {
      const _exhaustive: never = filter;
      return _exhaustive;
    }
  }
}

export function sortLibraryCourses(
  courses: Course[],
  sort: LibrarySortOption,
  progress: Map<string, CourseProgressSummary>,
): Course[] {
  const next = [...courses];
  switch (sort) {
    case 'title':
      next.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case 'duration':
      next.sort((a, b) => (b.duration_seconds || 0) - (a.duration_seconds || 0));
      break;
    case 'progress':
      next.sort((a, b) => (progress.get(b.id)?.percent ?? 0) - (progress.get(a.id)?.percent ?? 0));
      break;
    case 'recent':
      // Continue-watching order is already recency-shaped; prefer courses with progress first.
      next.sort((a, b) => {
        const ap = progress.has(a.id) ? 1 : 0;
        const bp = progress.has(b.id) ? 1 : 0;
        if (bp !== ap) return bp - ap;
        return a.title.localeCompare(b.title);
      });
      break;
    default: {
      const _exhaustive: never = sort;
      return _exhaustive;
    }
  }
  return next;
}

export function libraryLoadFailureCopy(message: string): { title: string; description: string } {
  return {
    title: 'Could not load your library',
    description: message || 'Course library temporarily unavailable.',
  };
}
