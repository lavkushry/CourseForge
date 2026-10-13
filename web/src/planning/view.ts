import { ApiClient, ApiError, errorMessage } from '../api';
import { PlanningApi } from './api';
import { Commands } from '../learning/api';
import * as c from './contracts';
import { svgIcon } from '../icons';

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

export class PlanningView {
  private readonly root: HTMLElement;
  private readonly api: ApiClient;
  private readonly planningApi: PlanningApi;
  private readonly hooks: PlanningHooks;
  private readonly commands = new Commands();
  private abortController: AbortController | null = null;

  private activeTab: 'daily' | 'weekly' | 'focus' | 'habits' | 'roadmap' = 'daily';
  private studyDate: string = '2026-10-13';
  private weekStart: string = '2026-10-12';
  private currentDay: c.Day | null = null;
  private currentWeek: c.Week | null = null;
  private preferences: c.Preferences | null = null;
  private weekPreferences: c.WeekPreferences | null = null;
  private currentFocus: c.Focus | null = null;
  private currentHabits: c.Habits | null = null;
  private currentInsights: c.Insights | null = null;
  private statusMessage = '';
  private focusLessonId: string | undefined = undefined;
  private focusTitle = 'Source study';
  private focusDurationMinutes = 25;
  private weekdayMinutes: number[] = [45, 45, 45, 45, 45, 0, 0];
  private selectedPathId: string | null = null;
  private reportedMinutes: Record<string, number> = {};
  private pathsList: Array<{ id: string; goal: string }> = [];
  private roadmapData: any = null;
  private roadmapLoading = false;

  constructor(
    rootOrOptions: HTMLElement | PlanningViewOptions,
    apiClient?: ApiClient,
    hooks?: PlanningHooks,
  ) {
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

  private get signal(): AbortSignal {
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

  async open(tab: 'daily' | 'weekly' | 'focus' | 'habits' | 'roadmap' = 'daily', externalSignal?: AbortSignal): Promise<void> {
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

  private render(): void {
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
      btn.onclick = () => { void this.open(t.id); };
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
      wrap.append(this.renderDaily());
    } else if (this.activeTab === 'weekly') {
      wrap.append(this.renderWeekly());
    } else if (this.activeTab === 'focus') {
      wrap.append(this.renderFocus());
    } else if (this.activeTab === 'habits') {
      wrap.append(this.renderHabits());
    } else if (this.activeTab === 'roadmap') {
      wrap.append(this.renderRoadmap());
    }

    this.root.append(wrap);
  }

  private renderDaily(): HTMLElement {
    const sec = document.createElement('section');
    sec.className = 'planning-tab-content daily-plan-section';

    // 1. Corporate LMS Momentum & Stats Header (Dribbble 27240387)
    const statsGrid = document.createElement('div');
    statsGrid.className = 'planning-overview-grid';

    const currentMinutes = this.preferences?.daily_minutes ?? 45;
    const items = this.currentDay?.items || [];
    const completedCount = this.currentDay?.completed_count ?? items.filter(it => it.status === 'done').length;

    const cardsData = [
      {
        icon: 'target',
        title: 'Daily Goal',
        value: `${currentMinutes}m`,
        sub: `${Math.min(currentMinutes, completedCount * 25)}m completed today`,
        tag: 'FOCUS TARGET',
      },
      {
        icon: 'flame',
        title: 'Weekly Streak',
        value: '5 Days',
        sub: '86% consistency score',
        tag: 'ACTIVE STREAK',
      },
      {
        icon: 'graduation',
        title: 'Masterclasses',
        value: '3 Enrolled',
        sub: '62% average progress',
        tag: 'LEARNING PATH',
      },
      {
        icon: 'award',
        title: 'Retention Mastery',
        value: '94%',
        sub: '24 cards & quizzes',
        tag: 'SPACED RECALL',
      },
    ] as const;

    for (const c of cardsData) {
      const card = document.createElement('div');
      card.className = 'momentum-stat-card';
      const iconWrap = document.createElement('div');
      iconWrap.className = 'momentum-card-icon';
      iconWrap.append(svgIcon(c.icon as any));

      const cardBody = document.createElement('div');
      cardBody.className = 'momentum-card-body';
      const tagEl = document.createElement('span');
      tagEl.className = 'momentum-card-tag';
      tagEl.textContent = c.tag;
      const valEl = document.createElement('strong');
      valEl.className = 'momentum-card-value';
      valEl.textContent = c.value;
      const subEl = document.createElement('span');
      subEl.className = 'momentum-card-sub';
      subEl.textContent = c.sub;

      cardBody.append(tagEl, valEl, subEl);
      card.append(iconWrap, cardBody);
      statsGrid.append(card);
    }
    sec.append(statsGrid);

    // 2. 7-Day Weekly Calendar Strip
    const stripCard = document.createElement('div');
    stripCard.className = 'planning-card calendar-strip-card';
    const stripHead = document.createElement('div');
    stripHead.className = 'calendar-strip-head';
    const stripTitle = document.createElement('h3');
    stripTitle.textContent = 'This Week’s Schedule';
    const stripDate = document.createElement('span');
    stripDate.className = 'muted';
    stripDate.textContent = 'Week of ' + this.weekStart;
    stripHead.append(stripTitle, stripDate);

    const stripRow = document.createElement('div');
    stripRow.className = 'calendar-strip-row';
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    for (let i = 0; i < 7; i++) {
      const dayPill = document.createElement('div');
      dayPill.className = i === 1 ? 'calendar-day-pill today-active' : (i < 1 ? 'calendar-day-pill day-complete' : 'calendar-day-pill');
      const dName = document.createElement('span');
      dName.className = 'day-pill-name';
      dName.textContent = dayNames[i] ?? "";
      const dDot = document.createElement('span');
      dDot.className = 'day-pill-dot';
      dayPill.append(dName, dDot);
      stripRow.append(dayPill);
    }
    stripCard.append(stripHead, stripRow);
    sec.append(stripCard);

    // 3. Heading & Preferences Card
    const h = document.createElement('h2');
    h.className = 'planning-heading';
    h.textContent = 'Daily plan';
    sec.append(h);

    const prefCard = document.createElement('div');
    prefCard.className = 'planning-card daily-preferences-card';

    const prefTop = document.createElement('div');
    prefTop.className = 'daily-preferences-top';

    const prefLabel = document.createElement('label');
    prefLabel.htmlFor = 'daily-minutes';
    prefLabel.textContent = 'Daily study minutes';

    const prefInput = document.createElement('input');
    prefInput.id = 'daily-minutes';
    prefInput.type = 'number';
    prefInput.min = '15';
    prefInput.max = '180';
    prefInput.value = String(this.preferences?.daily_minutes ?? 45);

    // Quick Budget Selection Pills
    const budgetPillsRow = document.createElement('div');
    budgetPillsRow.className = 'budget-pills-row';
    for (const [mVal, mLabel] of [
      [15, '15m Spark'],
      [30, '30m Core'],
      [45, '45m Deep'],
      [60, '60m Master'],
      [90, '90m Marathon'],
    ] as const) {
      const bBtn = document.createElement('button');
      bBtn.type = 'button';
      bBtn.className = Number(prefInput.value) === mVal ? 'budget-choice-pill active' : 'budget-choice-pill';
      bBtn.textContent = mLabel;
      bBtn.onclick = () => {
        prefInput.value = String(mVal);
        for (const sibling of budgetPillsRow.querySelectorAll('.budget-choice-pill')) {
          sibling.classList.remove('active');
        }
        bBtn.classList.add('active');
      };
      budgetPillsRow.append(bBtn);
    }

    const savePrefBtn = document.createElement('button');
    savePrefBtn.type = 'button';
    savePrefBtn.className = 'button primary save-pref-btn';
    savePrefBtn.textContent = 'Save preferences';
    savePrefBtn.onclick = async () => {
      const minutes = Number(prefInput.value || 45);
      const body = {
        daily_minutes: minutes,
        path_id: this.selectedPathId,
        expected_revision: this.preferences?.revision ?? 0,
      };
      const key = this.commands.get('planner:preferences', body).key;
      try {
        const updated = await this.planningApi.savePreferences(body, key, this.signal);
        this.preferences = updated;
        prefInput.value = String(updated.daily_minutes);
        this.statusMessage = 'Preferences saved.';
        this.render();
      } catch (err) {
        this.statusMessage = errorMessage(err);
        this.render();
      }
    };

    prefTop.append(prefLabel, prefInput, savePrefBtn);
    prefCard.append(prefTop, budgetPillsRow);
    sec.append(prefCard);

    // 4. Checklist Summary Badge
    const summaryEl = document.createElement('div');
    summaryEl.className = 'checklist-summary-badge';
    summaryEl.textContent = `${completedCount}/${items.length} checklist complete`;
    sec.append(summaryEl);

    // 5. Items Grid / Recommended Focus
    const list = document.createElement('div');
    list.className = 'planning-items-grid';

    for (const item of items) {
      const card = document.createElement('div');
      card.className = item.status === 'done' ? 'plan-item-card done' : 'plan-item-card';

      const itemH = document.createElement('h3');
      itemH.textContent = item.title;
      card.append(itemH);

      const desc = document.createElement('p');
      desc.className = 'muted';
      desc.textContent = `${item.minutes} min · ${item.description}`;
      card.append(desc);

      if (item.actual_minutes > 0) {
        const rep = document.createElement('span');
        rep.className = 'tag self-reported-tag';
        rep.textContent = `${item.actual_minutes} min self-reported`;
        card.append(rep);
      }

      if (item.status !== 'done') {
        const markBtn = document.createElement('button');
        markBtn.type = 'button';
        markBtn.className = 'button';
        markBtn.textContent = `Mark done: ${item.title}`;
        markBtn.onclick = async () => {
          const body = { status: 'done' as const, expected_revision: item.revision };
          const key = this.commands.get(`planner:items:${item.id}:status`, body).key;
          try {
            const updated = await this.planningApi.status(item, 'done', key, this.signal);
            this.currentDay = updated;
            this.statusMessage = '';
            this.render();
          } catch (err) {
            this.statusMessage = errorMessage(err);
            this.render();
          }
        };
        card.append(markBtn);
      }

      // Reported time form
      const timeBox = document.createElement('div');
      timeBox.className = 'reported-time-row';

      const repLabel = document.createElement('label');
      repLabel.htmlFor = `actual-minutes-${item.id}`;
      repLabel.textContent = `Reported minutes for ${item.title}`;

      const repInput = document.createElement('input');
      repInput.id = `actual-minutes-${item.id}`;
      repInput.type = 'number';
      repInput.min = '0';
      repInput.max = '600';
      repInput.value = this.reportedMinutes[item.id] !== undefined
        ? String(this.reportedMinutes[item.id])
        : (item.actual_minutes > 0 ? String(item.actual_minutes) : '');

      const saveTimeBtn = document.createElement('button');
      saveTimeBtn.type = 'button';
      saveTimeBtn.className = 'button quiet';
      saveTimeBtn.textContent = 'Save time';
      saveTimeBtn.onclick = async () => {
        const minutes = Number(repInput.value || 0);
        this.reportedMinutes[item.id] = minutes;
        const body = { actual_minutes: minutes, expected_revision: item.revision };
        const key = this.commands.get(`planner:items:${item.id}:actual`, body).key;
        try {
          const updated = await this.planningApi.actual(item, minutes, key, this.signal);
          this.currentDay = updated;
          this.statusMessage = '';
          this.render();
        } catch (err) {
          this.statusMessage = errorMessage(err);
          this.render();
        }
      };
      timeBox.append(repLabel, repInput, saveTimeBtn);
      card.append(timeBox);

      if (item.action) {
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'button quiet';
        openBtn.textContent = 'Open source';
        openBtn.onclick = async () => {
          if (this.hooks.navigate) {
            await this.hooks.navigate(item.action);
          }
        };
        card.append(openBtn);
      }

      list.append(card);
    }

    // If items are empty, render Recommended Daily Curriculum Cards
    if (items.length === 0) {
      const recSection = document.createElement('div');
      recSection.className = 'recommended-focus-section';
      const recHeading = document.createElement('div');
      recHeading.className = 'recommended-heading-row';
      recHeading.append(
        (() => { const s = document.createElement('span'); s.className = 'eyebrow'; s.textContent = 'TODAY’S RECOMMENDED CURRICULUM'; return s; })(),
        (() => { const h3 = document.createElement('h3'); h3.textContent = 'Targeted Mastery Goals'; return h3; })(),
        (() => { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Tailored to keep your momentum high and accelerate your software engineering mastery.'; return p; })(),
      );
      recSection.append(recHeading);

      const recGrid = document.createElement('div');
      recGrid.className = 'recommended-focus-grid';

      const recTasks = [
        {
          tag: 'STREAMING LECTURE',
          title: 'Deep Focus Masterclass Lecture',
          desc: 'Resume your current system design or data engineering video module with zero-buffering adaptive streaming.',
          duration: '25 min',
          actionText: 'Stream Lecture ↗',
          icon: 'play',
          action: () => {
            const coursesBtn = document.querySelector<HTMLButtonElement>('[data-catalog-view="courses"]');
            coursesBtn?.click();
          },
        },
        {
          tag: 'SPACED REPETITION',
          title: 'Review Retention Flashcards',
          desc: 'Practice 10 due concept cards with SM-2 spaced repetition to solidify long-term memory retention.',
          duration: '10 min',
          actionText: 'Open Review Deck ↗',
          icon: 'cards',
          action: () => {
            const revBtn = document.querySelector<HTMLButtonElement>('[data-catalog-view="reviews"]');
            revBtn?.click();
          },
        },
        {
          tag: 'SANDBOX PRACTICE',
          title: 'Hands-on Engineering Lab',
          desc: 'Write real SQL CTE window queries or PySpark broadcast joins in the verified container sandbox.',
          duration: '15 min',
          actionText: 'Launch Sandbox Lab ↗',
          icon: 'terminal',
          action: () => {
            const labBtn = document.querySelector<HTMLButtonElement>('[data-catalog-view="labs"]');
            labBtn?.click();
          },
        },
      ];

      for (const t of recTasks) {
        const tCard = document.createElement('div');
        tCard.className = 'recommended-task-card';

        const tTop = document.createElement('div');
        tTop.className = 'task-card-top';
        const tTag = document.createElement('span');
        tTag.className = 'task-card-tag';
        tTag.textContent = t.tag;
        const tDur = document.createElement('span');
        tDur.className = 'task-card-dur';
        tDur.textContent = t.duration;
        tTop.append(tTag, tDur);

        const tH = document.createElement('h4');
        tH.className = 'task-card-title';
        tH.textContent = t.title;

        const tDesc = document.createElement('p');
        tDesc.className = 'task-card-desc muted';
        tDesc.textContent = t.desc;

        const tBtn = document.createElement('button');
        tBtn.type = 'button';
        tBtn.className = 'button primary task-action-btn';
        tBtn.textContent = t.actionText;
        tBtn.onclick = t.action;

        tCard.append(tTop, tH, tDesc, tBtn);
        recGrid.append(tCard);
      }

      recSection.append(recGrid);
      list.append(recSection);
    }

    sec.append(list);

    return sec;
  }
  private renderWeekly(): HTMLElement {
    const sec = document.createElement('section');
    sec.className = 'planning-tab-content weekly-plan-section';

    const h = document.createElement('h2');
    h.className = 'planning-heading';
    h.textContent = 'Weekly calendar';
    sec.append(h);

    const weekCard = document.createElement('div');
    weekCard.className = 'planning-card weekly-setup-card';

    const weekLabel = document.createElement('label');
    weekLabel.htmlFor = 'week-containing';
    weekLabel.textContent = 'Week containing';

    const weekInput = document.createElement('input');
    weekInput.id = 'week-containing';
    weekInput.type = 'date';
    weekInput.value = this.weekStart;
    weekInput.onchange = () => {
      try {
        this.weekStart = c.monday(weekInput.value);
        weekInput.value = this.weekStart;
      } catch {}
    };
    weekCard.append(weekLabel, weekInput);

    const grid = document.createElement('div');
    grid.className = 'weekday-budgets-grid';

    const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    for (let i = 0; i < 7; i++) {
      const box = document.createElement('div');
      box.className = 'weekday-box';

      const lbl = document.createElement('label');
      lbl.htmlFor = `weekday-${i}`;
      lbl.textContent = `${weekdayNames[i]} study minutes`;

      const inp = document.createElement('input');
      inp.id = `weekday-${i}`;
      inp.type = 'number';
      inp.min = '0';
      inp.max = '180';
      inp.value = String(this.weekdayMinutes[i] ?? 0);
      inp.oninput = () => {
        this.weekdayMinutes[i] = Number(inp.value || 0);
      };

      box.append(lbl, inp);
      grid.append(box);
    }
    weekCard.append(grid);

    const buildBtn = document.createElement('button');
    buildBtn.type = 'button';
    buildBtn.className = 'button primary';
    buildBtn.textContent = 'Build weekly calendar';
    buildBtn.onclick = async () => {
      for (let i = 0; i < 7; i++) {
        const inp = this.root.querySelector<HTMLInputElement>(`#weekday-${i}`);
        if (inp) this.weekdayMinutes[i] = Number(inp.value || 0);
      }

      const wpBody = {
        weekday_minutes: this.weekdayMinutes,
        expected_revision: this.weekPreferences?.revision ?? 0,
      };
      const wpKey = this.commands.get('planner:week-preferences', wpBody).key;
      try {
        this.weekPreferences = await this.planningApi.saveWeekPreferences(wpBody, wpKey, this.signal);
      } catch {}

      const genBody = {
        week_start: this.weekStart,
        refresh: true,
        expected_revision: this.currentWeek?.revision ?? 0,
      };
      const genKey = this.commands.get('planner:weeks', genBody).key;
      try {
        this.currentWeek = await this.planningApi.generateWeek(genBody, genKey, this.signal);
        this.render();
      } catch (err) {
        this.statusMessage = errorMessage(err);
        this.render();
      }
    };
    weekCard.append(buildBtn);
    sec.append(weekCard);

    if (this.currentWeek?.days) {
      const daysGrid = document.createElement('div');
      daysGrid.className = 'weekly-days-display';

      for (const d of this.currentWeek.days) {
        const dayCard = document.createElement('div');
        dayCard.className = 'week-day-display-card';

        const dayHead = document.createElement('strong');
        dayHead.textContent = `${d.date} (${d.planned_minutes}m)`;
        dayCard.append(dayHead);

        if (d.rest_day || d.budget_minutes === 0) {
          const restBadge = document.createElement('span');
          restBadge.className = 'rest-day-badge';
          restBadge.textContent = 'Rest day';
          dayCard.append(restBadge);
        }

        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'button quiet';
        openBtn.textContent = `Open day ${d.date}`;
        openBtn.onclick = async () => {
          this.studyDate = d.date;
          await this.open('daily');
        };
        dayCard.append(openBtn);
        daysGrid.append(dayCard);
      }
      sec.append(daysGrid);
    }

    return sec;
  }

  private renderFocus(): HTMLElement {
    const sec = document.createElement('section');
    sec.className = 'planning-tab-content focus-timer-section';

    const h = document.createElement('h2');
    h.className = 'planning-heading';
    h.textContent = 'Focus timer';
    sec.append(h);

    const card = document.createElement('div');
    card.className = 'planning-card focus-card';

    if (this.currentFocus && (this.currentFocus.status === 'running' || this.currentFocus.status === 'paused')) {
      const statusP = document.createElement('p');
      statusP.className = 'focus-status-display';
      const modeName = this.currentFocus.mode === 'focus' ? 'Focus' : 'Break';
      statusP.textContent = `${modeName} · ${this.currentFocus.status}`;
      card.append(statusP);

      const controlsRow = document.createElement('div');
      controlsRow.className = 'focus-actions-row';

      if (this.currentFocus.status === 'running') {
        const pauseBtn = document.createElement('button');
        pauseBtn.type = 'button';
        pauseBtn.className = 'button';
        pauseBtn.textContent = 'Pause';
        pauseBtn.onclick = async () => {
          const body = { action: 'pause' as const, expected_revision: this.currentFocus!.revision };
          const key = this.commands.get(`focus:actions:${this.currentFocus!.id}:pause`, body).key;
          try {
            this.currentFocus = await this.planningApi.focusAction(this.currentFocus!, 'pause', key, this.signal);
            this.render();
          } catch (err) {
            this.statusMessage = errorMessage(err);
            this.render();
          }
        };
        controlsRow.append(pauseBtn);
      } else if (this.currentFocus.status === 'paused') {
        const resumeBtn = document.createElement('button');
        resumeBtn.type = 'button';
        resumeBtn.className = 'button primary';
        resumeBtn.textContent = 'Resume';
        resumeBtn.onclick = async () => {
          const body = { action: 'resume' as const, expected_revision: this.currentFocus!.revision };
          const key = this.commands.get(`focus:actions:${this.currentFocus!.id}:resume`, body).key;
          try {
            this.currentFocus = await this.planningApi.focusAction(this.currentFocus!, 'resume', key, this.signal);
            this.render();
          } catch (err) {
            this.statusMessage = errorMessage(err);
            this.render();
          }
        };
        controlsRow.append(resumeBtn);
      }

      const finishBtn = document.createElement('button');
      finishBtn.type = 'button';
      finishBtn.className = 'button';
      finishBtn.textContent = 'Finish session';
      finishBtn.onclick = async () => {
        const body = { action: 'finish' as const, expected_revision: this.currentFocus!.revision };
        const key = this.commands.get(`focus:actions:${this.currentFocus!.id}:finish`, body).key;
        try {
          await this.planningApi.focusAction(this.currentFocus!, 'finish', key, this.signal);
          this.currentFocus = null;
          this.render();
        } catch (err) {
          this.statusMessage = errorMessage(err);
          this.render();
        }
      };
      controlsRow.append(finishBtn);

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'button quiet';
      cancelBtn.textContent = 'Cancel session';
      cancelBtn.onclick = async () => {
        const body = { action: 'cancel' as const, expected_revision: this.currentFocus!.revision };
        const key = this.commands.get(`focus:actions:${this.currentFocus!.id}:cancel`, body).key;
        try {
          await this.planningApi.focusAction(this.currentFocus!, 'cancel', key, this.signal);
          this.currentFocus = null;
          this.render();
        } catch (err) {
          this.statusMessage = errorMessage(err);
          this.render();
        }
      };
      controlsRow.append(cancelBtn);

      card.append(controlsRow);
    } else {
      const clockDisplay = document.createElement('div');
      clockDisplay.className = 'focus-digital-clock';
      clockDisplay.textContent = `${String(this.focusDurationMinutes).padStart(2, '0')}:00`;
      const emptyP = document.createElement('p');
      emptyP.className = 'muted no-active-timer-msg';
      emptyP.textContent = 'No active timer';
      card.append(clockDisplay, emptyP);
    }

    const curLesson = this.hooks.currentLesson?.();
    if (curLesson) {
      const linkLessonBtn = document.createElement('button');
      linkLessonBtn.type = 'button';
      linkLessonBtn.className = 'button quiet';
      linkLessonBtn.textContent = 'Focus on current lesson';
      linkLessonBtn.onclick = () => {
        this.focusLessonId = curLesson.id;
        this.focusTitle = curLesson.title;
        this.statusMessage = `Linked to lesson: ${curLesson.title}`;
        this.render();
      };
      card.append(linkLessonBtn);
    }

    const startRow = document.createElement('div');
    startRow.className = 'focus-start-row';

    const durLabel = document.createElement('label');
    durLabel.htmlFor = 'focus-duration';
    durLabel.textContent = 'Duration minutes';

    const durInput = document.createElement('input');
    durInput.id = 'focus-duration';
    durInput.type = 'number';
    durInput.min = '1';
    durInput.max = '120';
    durInput.value = String(this.focusDurationMinutes);
    durInput.oninput = () => {
      this.focusDurationMinutes = Number(durInput.value || 25);
    };

    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'button primary';
    startBtn.textContent = 'Start timer';
    startBtn.onclick = async () => {
      const mins = Number(durInput.value || 25);
      const body: { mode: 'focus'; duration_minutes: number; title: string; lesson_id?: string } = {
        mode: 'focus',
        duration_minutes: mins,
        title: this.focusTitle,
      };
      if (this.focusLessonId) {
        body.lesson_id = this.focusLessonId;
      }
      const key = this.commands.get('focus:sessions', body).key;
      try {
        this.currentFocus = await this.planningApi.start(body, key, this.signal);
        this.render();
      } catch (err) {
        this.statusMessage = errorMessage(err);
        this.render();
      }
    };

    startRow.append(durLabel, durInput, startBtn);
    card.append(startRow);
    sec.append(card);

    return sec;
  }

  private renderHabits(): HTMLElement {
    const sec = document.createElement('section');
    sec.className = 'planning-tab-content habits-section';

    const h = document.createElement('h2');
    h.className = 'planning-heading';
    h.textContent = 'Habits & Insights';
    sec.append(h);

    const card = document.createElement('div');
    card.className = 'planning-card habits-card';

    const tzLabel = document.createElement('label');
    tzLabel.htmlFor = 'habit-timezone';
    tzLabel.textContent = 'Learning timezone';

    const tzInput = document.createElement('input');
    tzInput.id = 'habit-timezone';
    tzInput.type = 'text';
    tzInput.value = this.currentHabits?.preferences.timezone || 'UTC';
    if (this.currentHabits?.timezone_anchored) {
      tzInput.disabled = true;
    }

    const goalLabel = document.createElement('label');
    goalLabel.htmlFor = 'habit-goal';
    goalLabel.textContent = 'Daily habit goal';

    const goalSelect = document.createElement('select');
    goalSelect.id = 'habit-goal';
    const optMin = document.createElement('option');
    optMin.value = 'minutes';
    optMin.textContent = 'minutes';
    const optLes = document.createElement('option');
    optLes.value = 'lesson';
    optLes.textContent = 'lesson';
    goalSelect.append(optMin, optLes);
    goalSelect.value = this.currentHabits?.preferences.goal || 'minutes';

    const remLabel = document.createElement('label');
    remLabel.htmlFor = 'habit-reminder';
    remLabel.textContent = 'Send a weekly learning reminder';

    const remCheck = document.createElement('input');
    remCheck.id = 'habit-reminder';
    remCheck.type = 'checkbox';
    remCheck.checked = Boolean(this.currentHabits?.preferences.reminder_email);

    const saveHabitsBtn = document.createElement('button');
    saveHabitsBtn.type = 'button';
    saveHabitsBtn.className = 'button primary';
    saveHabitsBtn.textContent = 'Save habit preferences';
    saveHabitsBtn.onclick = async () => {
      const tz = tzInput.value || 'UTC';
      const goal = goalSelect.value as 'minutes' | 'lesson';
      const reminder = remCheck.checked;
      const body = {
        goal,
        timezone: tz,
        reminder_email: reminder,
      };
      const key = this.commands.get('me:habit-preferences', body).key;
      try {
        this.currentHabits = await this.planningApi.saveHabits(body, key, this.signal);
        this.render();
      } catch (err) {
        this.statusMessage = errorMessage(err);
        this.render();
      }
    };

    card.append(tzLabel, tzInput, goalLabel, goalSelect, remLabel, remCheck, saveHabitsBtn);

    if (this.currentHabits && !this.currentHabits.reminder_delivery_available && this.currentHabits.preferences.reminder_email) {
      const warn = document.createElement('p');
      warn.className = 'habit-warning-text';
      warn.textContent = 'Delivery is not available at this time.';
      card.append(warn);
    }

    if (this.currentHabits) {
      const todayM = Math.floor(this.currentHabits.today.watched_seconds / 60);
      const weekM = Math.floor(this.currentHabits.week.watched_seconds / 60);
      const tP = document.createElement('p');
      tP.textContent = `${todayM} watched minutes`;
      const wP = document.createElement('p');
      wP.textContent = `${weekM} watched minutes`;
      card.append(tP, wP);
    }

    const recallBtn = document.createElement('button');
    recallBtn.type = 'button';
    recallBtn.className = 'button quiet';
    recallBtn.textContent = 'Recall insights';
    recallBtn.onclick = async () => {
      try {
        this.currentInsights = await this.planningApi.insights(this.signal);
        this.render();
      } catch (err) {
        this.statusMessage = errorMessage(err);
        this.render();
      }
    };
    card.append(recallBtn);

    if (this.currentInsights) {
      const p = document.createElement('p');
      p.className = 'insights-display';
      if (this.currentInsights.mastery_signal_percent === null) {
        p.textContent = 'No recall signal yet.';
      } else {
        p.textContent = `Mastery signal: ${this.currentInsights.mastery_signal_percent}%`;
      }
      card.append(p);
    }

    sec.append(card);
    return sec;
  }

  private renderRoadmap(): HTMLElement {
    const sec = document.createElement('section');
    sec.className = 'planning-section roadmap-section';

    const header = document.createElement('div');
    header.className = 'roadmap-header';
    const title = document.createElement('h2');
    title.textContent = 'Dynamic AI Learning Roadmap';
    const sub = document.createElement('p');
    sub.className = 'muted';
    sub.textContent = 'Personalized multi-week study milestones synthesized from real CourseForge courses and lessons.';
    header.append(title, sub);
    sec.append(header);

    // Goal Suggestions Row
    const goalRow = document.createElement('div');
    goalRow.className = 'roadmap-goals-row';
    const presets = [
      'Full-Stack Cloud & Distributed Systems',
      'Kubernetes & DevOps Platform Lead',
      'Golang High-Concurrency Systems Engineer',
      'Advanced AI & LLM Systems Engineer',
    ];

    const form = document.createElement('div');
    form.className = 'roadmap-form';
    const goalInput = document.createElement('input');
    goalInput.type = 'text';
    goalInput.className = 'form-input';
    goalInput.placeholder = 'Enter target engineering role or learning goal…';
    goalInput.value = 'Full-Stack Cloud & Distributed Systems';

    for (const p of presets) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'mode-pill';
      pill.textContent = p;
      pill.onclick = () => {
        goalInput.value = p;
        void triggerGenerate(p);
      };
      goalRow.append(pill);
    }
    sec.append(goalRow);

    const genBtn = document.createElement('button');
    genBtn.type = 'button';
    genBtn.className = 'button primary';
    genBtn.append(svgIcon('sparkle'), document.createTextNode(' Generate Dynamic AI Roadmap'));

    const triggerGenerate = async (goal: string) => {
      this.roadmapLoading = true;
      genBtn.disabled = true;
      genBtn.textContent = 'Synthesizing Roadmap…';
      try {
        this.roadmapData = await this.api.generateAiRoadmap(goal);
      } catch (err) {
        this.statusMessage = errorMessage(err);
      } finally {
        this.roadmapLoading = false;
        this.render();
      }
    };

    genBtn.onclick = () => void triggerGenerate(goalInput.value.trim());
    form.append(goalInput, genBtn);
    sec.append(form);

    const content = document.createElement('div');
    content.className = 'roadmap-content';

    if (this.roadmapLoading) {
      const loading = document.createElement('p');
      loading.className = 'muted';
      loading.textContent = 'Synthesizing personalized curriculum from CourseForge masterclasses…';
      content.append(loading);
    } else if (this.roadmapData && this.roadmapData.steps) {
      const meta = document.createElement('div');
      meta.className = 'roadmap-meta-badge-row';
      const wBadge = document.createElement('span');
      wBadge.className = 'badge-stat';
      wBadge.append(svgIcon('clock'), document.createTextNode(` ${this.roadmapData.estimated_weeks} Weeks Estimated`));
      const rBadge = document.createElement('span');
      rBadge.className = 'badge-stat';
      rBadge.append(svgIcon('target'), document.createTextNode(` Role: ${this.roadmapData.target_role}`));
      meta.append(wBadge, rBadge);
      content.append(meta);

      const timeline = document.createElement('div');
      timeline.className = 'roadmap-timeline';

      for (const step of this.roadmapData.steps) {
        const card = document.createElement('div');
        card.className = 'roadmap-step-card';

        const stepTop = document.createElement('div');
        stepTop.className = 'step-top-row';
        const sNum = document.createElement('span');
        sNum.className = 'step-num';
        sNum.textContent = `Stage ${step.step_number}`;
        const sHours = document.createElement('span');
        sHours.className = 'step-hours';
        sHours.textContent = `~${step.estimated_hours}h`;
        stepTop.append(sNum, sHours);

        const sTitle = document.createElement('h3');
        sTitle.textContent = step.title;

        const sCourse = document.createElement('p');
        sCourse.className = 'step-course-name';
        sCourse.append(svgIcon('book'), document.createTextNode(` Course: ${step.course_title}`));

        const sDesc = document.createElement('p');
        sDesc.className = 'step-desc muted';
        sDesc.textContent = step.description;

        const conceptsBox = document.createElement('div');
        conceptsBox.className = 'step-concepts-pills';
        for (const c of step.key_concepts || []) {
          const pill = document.createElement('span');
          pill.className = 'concept-pill';
          pill.textContent = c;
          conceptsBox.append(pill);
        }

        card.append(stepTop, sTitle, sCourse, sDesc, conceptsBox);
        timeline.append(card);
      }
      content.append(timeline);
    } else {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'Select a learning goal above or enter your dream role to generate a dynamic masterclass roadmap.';
      content.append(empty);
    }

    sec.append(content);
    return sec;
  }
}
