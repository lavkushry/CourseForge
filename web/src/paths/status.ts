import type { LearningPath, PathStep } from './contracts';

/** True when every prerequisite step is completed (or there are none). */
export function stepUnlocked(path: LearningPath, step: PathStep): boolean {
  if (!step.prerequisites.length) return true;
  const byId = new Map(path.steps.map(s => [s.id, s]));
  return step.prerequisites.every(id => {
    const required = byId.get(id);
    return Boolean(required?.completed);
  });
}

/** Human labels for unmet prerequisites — never invents missing steps. */
export function unmetPrerequisiteTitles(path: LearningPath, step: PathStep): string[] {
  if (!step.prerequisites.length) return [];
  const byId = new Map(path.steps.map(s => [s.id, s]));
  const titles: string[] = [];
  for (const id of step.prerequisites) {
    const required = byId.get(id);
    if (!required) {
      titles.push(id);
      continue;
    }
    if (!required.completed) titles.push(required.title || id);
  }
  return titles;
}

export function isFixtureCourseId(id: string): boolean {
  return id.startsWith('fixture-');
}

/** Drop fixture / empty course IDs from create/display lists. */
export function realCourseIds(ids: string[]): string[] {
  return ids.filter(id => id && !isFixtureCourseId(id));
}

export function pathsLoadFailureCopy(message: string): { title: string; description: string } {
  return {
    title: 'Could not load learning roadmaps',
    description: message || 'Learning paths temporarily unavailable.',
  };
}
