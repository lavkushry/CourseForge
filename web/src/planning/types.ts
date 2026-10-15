import type { ApiClient } from '../api';

export interface PlanningHooks {
  unauthorized?: () => void;
  navigate?: (action: unknown) => Promise<void>;
  paths?: () => Promise<Array<{ id: string; goal: string }>>;
  currentLesson?: () => { id: string; title: string } | null;
}

export interface PlanningViewOptions {
  root: HTMLElement;
  api: ApiClient;
  onNavigateLesson?: (lessonId: string) => void;
  hooks?: PlanningHooks;
}
