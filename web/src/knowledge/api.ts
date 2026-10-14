import type { AskResponse, KnowledgeChapter, LessonKnowledge } from './types';

export type KnowledgeFetcher = (path: string, init?: RequestInit) => Promise<unknown>;

export async function fetchLessonKnowledge(fetcher: KnowledgeFetcher, lessonId: string): Promise<LessonKnowledge> {
  if (!lessonId) {
    throw new Error('lessonId is required');
  }
  const data = await fetcher(`/api/v1/knowledge/lessons/${encodeURIComponent(lessonId)}`);
  return data as LessonKnowledge;
}

export async function fetchLessonChapters(fetcher: KnowledgeFetcher, lessonId: string): Promise<KnowledgeChapter[]> {
  if (!lessonId) {
    throw new Error('lessonId is required');
  }
  const data = (await fetcher(`/api/v1/knowledge/lessons/${encodeURIComponent(lessonId)}/chapters`)) as {
    chapters?: KnowledgeChapter[];
  };
  return data.chapters ?? [];
}

export async function askLessonKnowledge(
  fetcher: KnowledgeFetcher,
  lessonId: string,
  question: string,
): Promise<AskResponse> {
  if (!lessonId) {
    throw new Error('lessonId is required');
  }
  const data = await fetcher(`/api/v1/knowledge/lessons/${encodeURIComponent(lessonId)}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  return data as AskResponse;
}

export function formatKnowledgeClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Parse [m:ss] / [mm:ss] citation labels from an ask answer. */
export function parseCitationLabels(answer: string): string[] {
  const labels: string[] = [];
  const re = /\[(\d{1,2}:\d{2})\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(answer)) !== null) {
    const label = match[1];
    if (label) labels.push(label);
  }
  return labels;
}

export function clockToMs(label: string): number {
  const parts = label.split(':');
  const m = Number.parseInt(parts[0] ?? '', 10);
  const s = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isFinite(m) || !Number.isFinite(s)) return 0;
  return (m * 60 + s) * 1000;
}
