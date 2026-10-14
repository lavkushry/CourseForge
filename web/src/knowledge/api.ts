import type { LessonKnowledge } from './types';

export type KnowledgeFetcher = (path: string) => Promise<unknown>;

export async function fetchLessonKnowledge(fetcher: KnowledgeFetcher, lessonId: string): Promise<LessonKnowledge> {
  if (!lessonId) {
    throw new Error('lessonId is required');
  }
  const data = await fetcher(`/api/v1/knowledge/lessons/${encodeURIComponent(lessonId)}`);
  return data as LessonKnowledge;
}

export function formatKnowledgeClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
