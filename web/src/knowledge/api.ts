import type {
  AskResponse,
  ConfusionHotspot,
  KnowledgeChapter,
  KnowledgeConcept,
  KnowledgeConceptPrereq,
  KnowledgeFlashcard,
  LessonKnowledge,
  RecallQuestion,
  ReviewQueueItem,
} from './types';

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

export async function fetchLessonConcepts(
  fetcher: KnowledgeFetcher,
  lessonId: string,
): Promise<{ concepts: KnowledgeConcept[]; prereqs: KnowledgeConceptPrereq[] }> {
  const data = (await fetcher(`/api/v1/knowledge/lessons/${encodeURIComponent(lessonId)}/concepts`)) as {
    concepts?: KnowledgeConcept[];
    prereqs?: KnowledgeConceptPrereq[];
  };
  return { concepts: data.concepts ?? [], prereqs: data.prereqs ?? [] };
}

export async function fetchLessonRecall(fetcher: KnowledgeFetcher, lessonId: string): Promise<RecallQuestion[]> {
  const data = (await fetcher(`/api/v1/knowledge/lessons/${encodeURIComponent(lessonId)}/recall`)) as {
    questions?: RecallQuestion[];
  };
  return data.questions ?? [];
}

export async function fetchReviewQueue(fetcher: KnowledgeFetcher): Promise<ReviewQueueItem[]> {
  const data = (await fetcher('/api/v1/knowledge/review-queue')) as { items?: ReviewQueueItem[] };
  return data.items ?? [];
}

export async function submitReview(fetcher: KnowledgeFetcher, cardId: string, rating: number): Promise<unknown> {
  return fetcher(`/api/v1/knowledge/review/${encodeURIComponent(cardId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating }),
  });
}

export async function fetchLessonHotspots(fetcher: KnowledgeFetcher, lessonId: string): Promise<ConfusionHotspot[]> {
  const data = (await fetcher(`/api/v1/knowledge/lessons/${encodeURIComponent(lessonId)}/hotspots`)) as {
    hotspots?: ConfusionHotspot[];
  };
  return data.hotspots ?? [];
}

export async function fetchLessonFlashcards(
  fetcher: KnowledgeFetcher,
  lessonId: string,
): Promise<KnowledgeFlashcard[]> {
  const data = (await fetcher(`/api/v1/knowledge/lessons/${encodeURIComponent(lessonId)}/flashcards`)) as {
    flashcards?: KnowledgeFlashcard[];
  };
  return data.flashcards ?? [];
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
