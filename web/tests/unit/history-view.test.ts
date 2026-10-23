import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api';
import type { HistoryItem } from '../../src/contracts';
import { HistoryView } from '../../src/history/view';

function item(overrides: Partial<HistoryItem> = {}): HistoryItem {
  return {
    id: 'lesson-1',
    course_id: 'course-a',
    title: 'Lecture One',
    sort_order: 1,
    duration_seconds: 600,
    section_title: 'Module 1',
    flow_order: 1,
    position: 120,
    percent: 20,
    completed: false,
    watched_at: '2026-03-20T12:00:00.000Z',
    ...overrides,
  };
}

describe('HistoryView', () => {
  it('shows an error with retry instead of pretending history is empty', async () => {
    const root = document.createElement('div');
    const history = vi.fn().mockRejectedValue(new ApiError('Watch history temporarily unavailable.', 503));
    const view = new HistoryView({
      root,
      api: { history, clearHistory: vi.fn() } as never,
      onResumeLesson: vi.fn(),
    });
    view.activate(new AbortController().signal);
    await vi.waitFor(() => expect(root.textContent).toContain('Could not load watch history'));
    expect(root.textContent).toContain('Watch history temporarily unavailable.');
    expect(root.textContent).not.toContain('No watch history yet');
    expect(root.querySelector('button')?.textContent).toBe('Retry');
  });

  it('labels completed lessons and avoids false 0% when only position is known', async () => {
    const root = document.createElement('div');
    const history = vi.fn().mockResolvedValue({
      history: [
        item({ id: 'done', completed: true, percent: 100, position: 600 }),
        item({ id: 'unknown-duration', percent: 0, position: 45, duration_seconds: 0 }),
      ],
    });
    const view = new HistoryView({
      root,
      api: { history, clearHistory: vi.fn() } as never,
      onResumeLesson: vi.fn(),
    });
    view.activate(new AbortController().signal);
    await vi.waitFor(() => expect(root.textContent).toContain('Completed'));
    expect(root.textContent).toContain('Finished');
    expect(root.textContent).toContain('Resume at');
    expect(root.textContent).not.toMatch(/0% watched/);
  });
});
