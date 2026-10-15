import type { ApiClient } from '../api';
import { ApiError } from '../api';
import { PlanningApi } from './api';
import { Commands } from '../learning/api';
import * as c from './contracts';
import './style.css';
import type { PlanningHooks, PlanningViewOptions } from './types';
import type { PlanningHost, PlanningTab } from './host';
import { renderDaily } from './daily-tab';
import { renderWeekly } from './weekly-tab';
import { renderFocus } from './focus-tab';
import { renderHabits } from './habits-tab';
import { renderRoadmap } from './roadmap-tab';

export type { PlanningHooks, PlanningViewOptions } from './types';

export class PlanningView implements PlanningHost {
  readonly root: HTMLElement;
  readonly api: ApiClient;
  readonly planningApi: PlanningApi;
  readonly hooks: PlanningHooks;
  readonly commands = new Commands();
  private abortController: AbortController | null = null;

  activeTab: PlanningTab = 'daily';
  studyDate: string = '2026-10-13';
  weekStart: string = '2026-10-12';
  currentDay: c.Day | null = null;
  currentWeek: c.Week | null = null;
  preferences: c.Preferences | null = null;
  weekPreferences: c.WeekPreferences | null = null;
  currentFocus: c.Focus | null = null;
  currentHabits: c.Habits | null = null;
  currentInsights: c.Insights | null = null;
  statusMessage = '';
  focusLessonId: string | undefined = undefined;
  focusTitle = 'Source study';
  focusDurationMinutes = 25;
  weekdayMinutes: number[] = [45, 45, 45, 45, 45, 0, 0];
  selectedPathId: string | null = null;
  reportedMinutes: Record<string, number> = {};
  pathsList: Array<{ id: string; goal: string }> = [];
  roadmapData: unknown = null;
  roadmapLoading = false;

  constructor(rootOrOptions: HTMLElement | PlanningViewOptions, apiClient?: ApiClient, hooks?: PlanningHooks) {
    if (rootOrOptions instanceof HTMLElement) {
      this.root = rootOrOptions;
      this.api = apiClient!;
      this.hooks = hooks || {};
    } else {
      this.root = rootOrOptions.root;
      this.api = rootOrOptions.api;
      this.hooks = rootOrOptions.hooks || {
        navigate: async (action: unknown) => {
          if (rootOrOptions.onNavigateLesson && typeof action === 'object' && action && 'lesson_id' in action) {
            rootOrOptions.onNavigateLesson((action as { lesson_id: string }).lesson_id);
          }
        },
      };
    }
    this.planningApi = new PlanningApi(this.api);
    try {
      this.studyDate = c.dateInZone('UTC');
      this.weekStart = c.monday(this.studyDate);
    } catch {}
  }

  get signal(): AbortSignal {
    if (!this.abortController) this.abortController = new AbortController();
    return this.abortController.signal;
  }

  activate(signal: AbortSignal, tab: 'daily' | 'weekly' | 'focus' | 'habits' | 'roadmap' = 'daily'): void {
    void this.open(tab, signal);
  }

  deactivate(): void {
    this.close();
  }

  close(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.commands.clear();
    this.root.replaceChildren();
    this.root.hidden = true;
  }

  async open(
    tab: 'daily' | 'weekly' | 'focus' | 'habits' | 'roadmap' = 'daily',
    externalSignal?: AbortSignal,
  ): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    const sig = externalSignal
      ? AbortSignal.any([this.abortController.signal, externalSignal])
      : this.abortController.signal;

    this.activeTab = tab;
    this.root.hidden = false;
    this.root.setAttribute('aria-busy', 'true');

    try {
      if (this.hooks.paths) {
        try {
          this.pathsList = await this.hooks.paths();
        } catch {
          this.pathsList = [];
        }
      }

      if (tab === 'daily') {
        await this.loadDaily(sig);
      } else if (tab === 'weekly') {
        await this.loadWeekly(sig);
      } else if (tab === 'focus') {
        await this.loadFocus(sig);
      } else if (tab === 'habits') {
        await this.loadHabits(sig);
      }
      this.render();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && this.hooks.unauthorized) {
        this.hooks.unauthorized();
        return;
      }
      this.render();
    } finally {
      this.root.setAttribute('aria-busy', 'false');
    }
  }

  private async loadDaily(signal: AbortSignal): Promise<void> {
    try {
      this.preferences = await this.planningApi.preferences(signal);
    } catch {}
    try {
      this.currentDay = await this.planningApi.day(this.studyDate, signal);
    } catch {}
  }

  private async loadWeekly(signal: AbortSignal): Promise<void> {
    try {
      this.weekPreferences = await this.planningApi.weekPreferences(signal);
      if (this.weekPreferences && this.weekPreferences.weekday_minutes.length === 7) {
        this.weekdayMinutes = [...this.weekPreferences.weekday_minutes];
      }
    } catch {}
    try {
      this.currentWeek = await this.planningApi.week(this.weekStart, signal);
    } catch {}
  }

  private async loadFocus(signal: AbortSignal): Promise<void> {
    try {
      this.currentFocus = await this.planningApi.active(signal);
    } catch {}
  }

  private async loadHabits(signal: AbortSignal): Promise<void> {
    try {
      this.currentHabits = await this.planningApi.habits(signal);
    } catch {}
  }

  render(): void {
    this.root.replaceChildren();

    const wrap = document.createElement('div');
    wrap.className = 'planning-container';

    // 1. Navigation Header
    const nav = document.createElement('nav');
    nav.className = 'planning-tabs';
    nav.setAttribute('aria-label', 'Planning sections');

    const tabs: Array<{ id: 'daily' | 'weekly' | 'focus' | 'habits' | 'roadmap'; label: string }> = [
      { id: 'daily', label: 'Daily plan' },
      { id: 'weekly', label: 'Weekly calendar' },
      { id: 'focus', label: 'Focus timer' },
      { id: 'habits', label: 'Habits & Insights' },
      { id: 'roadmap', label: 'AI Roadmap' },
    ];

    for (const t of tabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = this.activeTab === t.id ? 'planning-tab active' : 'planning-tab';
      btn.textContent = t.label;
      btn.onclick = () => {
        void this.open(t.id);
      };
      nav.append(btn);
    }
    wrap.append(nav);

    // Global Status
    const statusEl = document.createElement('p');
    statusEl.className = 'planning-status-alert';
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.textContent = this.statusMessage;
    wrap.append(statusEl);

    // Content by tab
    if (this.activeTab === 'daily') {
      wrap.append(renderDaily(this));
    } else if (this.activeTab === 'weekly') {
      wrap.append(renderWeekly(this));
    } else if (this.activeTab === 'focus') {
      wrap.append(renderFocus(this));
    } else if (this.activeTab === 'habits') {
      wrap.append(renderHabits(this));
    } else if (this.activeTab === 'roadmap') {
      wrap.append(renderRoadmap(this));
    }

    this.root.append(wrap);
  }
}
