import { ContractError } from '../validation';

export interface PathSource {
  lesson_id: string;
  course_id: string;
  start: number;
  chunk_id?: string | undefined;
  title?: string | undefined;
}

export interface PathStep {
  id: string;
  title: string;
  objectives: string[];
  sources: PathSource[];
  prerequisites: string[];
  goal_focus?: boolean | undefined;
  completed: boolean;
  watched_sources?: number | undefined;
}

export interface LearningPath {
  id: string;
  goal: string;
  course_ids: string[];
  steps: PathStep[];
  provenance: string;
  revision: number;
  completed_steps: number;
  completion_percent: number;
  assessed_topics?: number | undefined;
  topics_needing_practice?: number | undefined;
  next_step_id?: string | null | undefined;
  created_at: string;
  updated_at: string;
}

export function parseLearningPaths(value: unknown): { paths: LearningPath[]; next_cursor: string | null } {
  if (!value || typeof value !== 'object') throw new ContractError('learning paths response');
  const d = value as Record<string, unknown>;
  if (!Array.isArray(d.paths)) throw new ContractError('paths array');
  return {
    paths: d.paths.map(parsePath),
    next_cursor: typeof d.next_cursor === 'string' && d.next_cursor ? d.next_cursor : null,
  };
}

export function parsePath(value: unknown): LearningPath {
  if (!value || typeof value !== 'object') throw new ContractError('learning path');
  const d = value as Record<string, unknown>;
  const rawSteps = Array.isArray(d.steps) ? d.steps : [];
  const steps: PathStep[] = rawSteps.map((s: Record<string, unknown>) => ({
    id: String(s.id || ''),
    title: String(s.title || ''),
    objectives: Array.isArray(s.objectives) ? s.objectives.map(String) : [],
    prerequisites: Array.isArray(s.prerequisites) ? s.prerequisites.map(String) : [],
    goal_focus: Boolean(s.goal_focus),
    completed: Boolean(s.completed),
    watched_sources: Number(s.watched_sources || 0),
    sources: Array.isArray(s.sources)
      ? s.sources.map((src: Record<string, unknown>) => ({
          lesson_id: String(src.lesson_id || ''),
          course_id: String(src.course_id || ''),
          start: Number(src.start || 0),
          chunk_id: typeof src.chunk_id === 'string' ? src.chunk_id : undefined,
          title: typeof src.title === 'string' ? src.title : undefined,
        }))
      : [],
  }));

  return {
    id: String(d.id || ''),
    goal: String(d.goal || ''),
    course_ids: Array.isArray(d.course_ids) ? d.course_ids.map(String) : [],
    steps,
    provenance: String(d.provenance || 'manual'),
    revision: Number(d.revision || 1),
    completed_steps: Number(d.completed_steps || 0),
    completion_percent: Number(d.completion_percent || 0),
    assessed_topics: Number(d.assessed_topics || 0),
    topics_needing_practice: Number(d.topics_needing_practice || 0),
    next_step_id: typeof d.next_step_id === 'string' ? d.next_step_id : null,
    created_at: String(d.created_at || ''),
    updated_at: String(d.updated_at || ''),
  };
}
