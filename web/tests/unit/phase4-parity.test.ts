import { describe, expect, it } from 'vitest';
import { reviewsEmptyCopy, reviewsLoadFailureCopy } from '../../src/reviews/status';
import { tutorIsReady, tutorUnavailableCopy } from '../../src/tutor/status';
import { labsRunDisabled, labsUnavailableBanner } from '../../src/labs/status';

describe('phase 4 product parity honesty', () => {
  it('keeps review load failures distinct from an empty due queue', () => {
    expect(reviewsLoadFailureCopy('reviews unavailable')).toEqual({
      title: 'Could not load review cards',
      description: 'reviews unavailable',
    });
    expect(reviewsEmptyCopy(0).title).toBe('No flashcards due');
    expect(reviewsEmptyCopy(0).description).toContain('Nothing is invented');
    expect(reviewsEmptyCopy(2).title).toBe('You are caught up for now');
  });

  it('treats offline Ollama as not ready and never implies fabricated answers', () => {
    expect(tutorIsReady(null)).toBe(false);
    expect(
      tutorIsReady({
        ollama_online: false,
        pgvector_active: false,
        transcript_chunks: 0,
        ollama_chat_model: 'llama',
      }),
    ).toBe(false);
    expect(
      tutorIsReady({
        ollama_online: true,
        pgvector_active: true,
        transcript_chunks: 12,
        ollama_chat_model: 'llama',
      }),
    ).toBe(true);
    expect(
      tutorUnavailableCopy({
        ollama_online: false,
        pgvector_active: false,
        transcript_chunks: 0,
        ollama_chat_model: 'llama',
      }).description,
    ).toContain('answers are never invented');
  });

  it('disables lab grading when Docker graders are offline', () => {
    expect(labsRunDisabled(false)).toBe(true);
    expect(labsRunDisabled(true)).toBe(false);
    expect(labsUnavailableBanner(false, false)).toContain('Docker graders are not configured');
    expect(labsUnavailableBanner(false, true)).toContain('Kind grading is not available');
    expect(labsUnavailableBanner(true, true)).toBeNull();
  });
});
