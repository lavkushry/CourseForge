import { describe, expect, it, vi } from 'vitest';
import { fetchLessonKnowledge, formatKnowledgeClock, QDRANT_COLLECTION } from '../../src/knowledge';
import type { LessonKnowledge } from '../../src/knowledge';

describe('living video knowledge', () => {
  it('keeps the dedicated qdrant collection name isolated', () => {
    expect(QDRANT_COLLECTION).toBe('courseforge_living_video');
    expect(QDRANT_COLLECTION).not.toBe('courseforge_chunks');
  });

  it('formats clocks from millisecond timestamps', () => {
    expect(formatKnowledgeClock(0)).toBe('0:00');
    expect(formatKnowledgeClock(65_000)).toBe('1:05');
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
      },
      words: [],
      segments: [{ id: 's1', ordinal: 0, start_ms: 0, end_ms: 1000, text: 'hello' }],
      keyframes: [],
    };
    const fetcher = vi.fn(async () => payload);
    await expect(fetchLessonKnowledge(fetcher, 'lesson')).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/knowledge/lessons/lesson');
  });
});
