import { describe, expect, it } from 'vitest';
import type { HistoryItem } from '../../src/contracts';
import { historyLoadFailureCopy, historyStatusLabels } from '../../src/history/status';

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

describe('history status copy', () => {
  it('keeps load failures distinct from an empty history list', () => {
    expect(historyLoadFailureCopy('Watch history temporarily unavailable.')).toEqual({
      title: 'Could not load watch history',
      description: 'Watch history temporarily unavailable.',
    });
  });

  it('labels completed lessons and avoids false 0% when only position is known', () => {
    expect(historyStatusLabels(item({ completed: true, percent: 100, position: 600 }), 100, true)).toEqual({
      percentLabel: 'Completed',
      remainLabel: 'Finished',
    });
    expect(
      historyStatusLabels(item({ percent: 0, position: 45, duration_seconds: 0 }), 0, false).percentLabel,
    ).toMatch(/^Resume at /);
    expect(historyStatusLabels(item({ percent: 20, position: 120 }), 20, false)).toEqual({
      percentLabel: '20% watched',
      remainLabel: '8 min left',
    });
  });
});
