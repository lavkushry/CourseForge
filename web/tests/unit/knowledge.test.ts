import { describe, expect, it, vi } from 'vitest';
import {
  askLessonKnowledge,
  clockToMs,
  fetchLessonChapters,
  fetchLessonConcepts,
  fetchLessonHotspots,
  fetchLessonKnowledge,
  fetchLessonRecall,
  fetchReviewQueue,
  formatKnowledgeClock,
  parseCitationLabels,
  QDRANT_COLLECTION,
  submitReview,
} from '../../src/knowledge';
import type { AskResponse, LessonKnowledge } from '../../src/knowledge';

describe('living video knowledge', () => {
  it('keeps the dedicated qdrant collection name isolated', () => {
    expect(QDRANT_COLLECTION).toBe('courseforge_knowledge');
    expect(QDRANT_COLLECTION).not.toBe('courseforge_chunks');
  });

  it('formats clocks from millisecond timestamps', () => {
    expect(formatKnowledgeClock(0)).toBe('0:00');
    expect(formatKnowledgeClock(65_000)).toBe('1:05');
    expect(clockToMs('1:05')).toBe(65_000);
    expect(parseCitationLabels('See [1:05] and [0:12]')).toEqual(['1:05', '0:12']);
  });

  it('fetches lesson knowledge through the shared API boundary', async () => {
    const payload: LessonKnowledge = {
      document: {
        lesson_id: 'lesson',
        status: 'ready',
        asr_engine: 'mock',
        scene_engine: 'mock',
        ocr_engine: 'mock',
        word_count: 2,
        segment_count: 1,
        keyframe_count: 0,
        chapter_count: 1,
      },
      words: [],
      segments: [{ id: 's1', ordinal: 0, start_ms: 0, end_ms: 1000, text: 'hello' }],
      keyframes: [],
      chapters: [{ id: 'c1', ordinal: 0, start_ms: 0, end_ms: 1000, title: 'Intro', summary: 'hello' }],
    };
    const fetcher = vi.fn(async () => payload);
    await expect(fetchLessonKnowledge(fetcher, 'lesson')).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/knowledge/lessons/lesson');
  });

  it('fetches chapters and asks with citations', async () => {
    const chaptersFetcher = vi.fn(async () => ({
      chapters: [{ id: 'c1', ordinal: 0, start_ms: 0, end_ms: 1000, title: 'Intro', summary: 'hi' }],
    }));
    await expect(fetchLessonChapters(chaptersFetcher, 'lesson')).resolves.toHaveLength(1);

    const askPayload: AskResponse = {
      answer: 'Covered at [0:05].',
      abstained: false,
      support: 'supported',
      citations: [{ chunk_id: 'kc1', start_ms: 5000, end_ms: 8000, label: '0:05', text: 'detail' }],
    };
    const askFetcher = vi.fn(async () => askPayload);
    await expect(askLessonKnowledge(askFetcher, 'lesson', 'what?')).resolves.toEqual(askPayload);
    expect(askFetcher).toHaveBeenCalledWith(
      '/api/v1/knowledge/lessons/lesson/ask',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('fetches learning endpoints for recall, review, concepts, and hotspots', async () => {
    const conceptsFetcher = vi.fn(async () => ({
      concepts: [{ id: 'c1', slug: 'intro', title: 'Intro', summary: 'hi', ordinal: 0 }],
      prereqs: [],
    }));
    await expect(fetchLessonConcepts(conceptsFetcher, 'lesson')).resolves.toMatchObject({
      concepts: [expect.objectContaining({ slug: 'intro' })],
    });

    const recallFetcher = vi.fn(async () => ({
      questions: [{ id: 'q1', segment_end_ms: 1000, prompt: 'What?', answer: 'A' }],
    }));
    await expect(fetchLessonRecall(recallFetcher, 'lesson')).resolves.toHaveLength(1);

    const queueFetcher = vi.fn(async () => ({ items: [] }));
    await expect(fetchReviewQueue(queueFetcher)).resolves.toEqual([]);

    const reviewFetcher = vi.fn(async () => ({ reps: 1 }));
    await submitReview(reviewFetcher, 'card1', 3);
    expect(reviewFetcher).toHaveBeenCalledWith(
      '/api/v1/knowledge/review/card1',
      expect.objectContaining({ method: 'POST' }),
    );

    const hotFetcher = vi.fn(async () => ({ hotspots: [{ id: 'h1', lesson_id: 'lesson', bucket_ms: 0, score: 1 }] }));
    await expect(fetchLessonHotspots(hotFetcher, 'lesson')).resolves.toHaveLength(1);
  });
});
