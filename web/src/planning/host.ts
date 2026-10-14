import type { ApiClient } from '../api';
import type { PlanningApi } from './api';
import type { Commands } from '../learning/api';
import type * as c from './contracts';
import type { PlanningHooks } from './types';

export type PlanningTab = 'daily' | 'weekly' | 'focus' | 'habits' | 'roadmap';

export interface PlanningHost {
  root: HTMLElement;
  api: ApiClient;
  planningApi: PlanningApi;
  hooks: PlanningHooks;
  commands: Commands;
  activeTab: PlanningTab;
  studyDate: string;
  weekStart: string;
  currentDay: c.Day | null;
  currentWeek: c.Week | null;
  preferences: c.Preferences | null;
  weekPreferences: c.WeekPreferences | null;
  currentFocus: c.Focus | null;
  currentHabits: c.Habits | null;
  currentInsights: c.Insights | null;
  statusMessage: string;
  focusLessonId: string | undefined;
  focusTitle: string;
  focusDurationMinutes: number;
  weekdayMinutes: number[];
  selectedPathId: string | null;
  reportedMinutes: Record<string, number>;
  pathsList: Array<{ id: string; goal: string }>;
  roadmapData: unknown;
  roadmapLoading: boolean;
  readonly signal: AbortSignal;
  open(tab?: PlanningTab, externalSignal?: AbortSignal): Promise<void>;
  render(): void;
}
