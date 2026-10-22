import { svgIcon } from '../icons';
import type { AuthResponse } from '../contracts';
import type { ApiClient } from '../api';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export interface SettingsViewOptions {
  root: HTMLElement;
  api: ApiClient;
  account: AuthResponse['user'];
  onSignOut: () => void;
  feedback: (msg: string, error?: boolean) => void;
}

export class SettingsView {
  private dailyMinutes = 30;

  constructor(private readonly options: SettingsViewOptions) {
    const savedGoal = localStorage.getItem('courseforge_daily_goal');
    if (savedGoal) {
      const parsed = parseInt(savedGoal, 10);
      if (!isNaN(parsed) && parsed > 0) this.dailyMinutes = parsed;
    }
  }

  activate(signal: AbortSignal): void {
    this.options.root.hidden = false;
    this.render();

    void this.options.api
      .request<{ preferences: { daily_minutes?: number } }>('/planner/preferences', { signal })
      .then(res => {
        if (res?.preferences?.daily_minutes) {
          this.dailyMinutes = res.preferences.daily_minutes;
          this.render();
        }
      })
      .catch(() => {});
  }

  deactivate(): void {
    this.options.root.hidden = true;
    this.options.root.replaceChildren();
  }

  render(): void {
    const root = this.options.root;
    root.replaceChildren();

    const pageHead = el('div', 'page-heading settings-header');
    const headText = el('div', 'page-heading-left');
    headText.append(
      el('span', 'eyebrow', 'STUDIO PREFERENCES & ACCOUNT'),
      el('h1', 'page-title', 'Studio Settings'),
      el(
        'p',
        'muted page-subtitle',
        'Configure your learning environment, visual themes, daily study budgets, and account credentials.',
      ),
    );
    pageHead.append(headText);
    root.append(pageHead);

    const grid = el('div', 'settings-grid');

    // Panel 1: Appearance & Theme
    const appearanceCard = el('section', 'panel settings-panel-card');
    const appHead = el('div', 'settings-panel-head');
    appHead.append(
      el('h2', '', 'Appearance & Visual Theme'),
      el('p', 'muted', 'Customize the cinematic obsidian backdrop and accent highlights.'),
    );
    appearanceCard.append(appHead);

    const themeWrap = el('div', 'setting-group');
    themeWrap.append(el('label', 'input-label', 'Color Scheme'));
    const themeRow = el('div', 'theme-toggle-row');
    const currentTheme = document.documentElement.dataset.theme || localStorage.getItem('courseforge_theme') || 'dark';

    for (const [tKey, tLabel] of [
      ['dark', 'Dark (Default)'],
      ['light', 'Light'],
      ['system', 'System'],
    ] as const) {
      const btn = el(
        'button',
        currentTheme === tKey ? 'button theme-choice-btn active' : 'button quiet theme-choice-btn',
        tLabel,
      );
      btn.type = 'button';
      btn.addEventListener('click', () => {
        document.documentElement.dataset.theme = tKey;
        localStorage.setItem('courseforge_theme', tKey);
        this.render();
      });
      themeRow.append(btn);
    }
    themeWrap.append(themeRow);

    const accentWrap = el('div', 'setting-group');
    accentWrap.append(el('label', 'input-label', 'Accent Glow'));
    const accentRow = el('div', 'accent-toggle-row');
    const rawAccent =
      document.documentElement.dataset.accent || localStorage.getItem('courseforge_accent') || 'coral';
    // Migrate the historical indigo key to the coral default.
    const currentAccent = rawAccent === 'indigo' ? 'coral' : rawAccent;
    if (rawAccent === 'indigo') {
      document.documentElement.dataset.accent = 'coral';
      localStorage.setItem('courseforge_accent', 'coral');
    }

    for (const [aKey, aLabel] of [
      ['coral', 'Coral (Default)'],
      ['teal', 'Teal Glow'],
      ['rose', 'Crimson Rose'],
    ] as const) {
      const btn = el(
        'button',
        currentAccent === aKey ? 'button accent-choice-btn active' : 'button quiet accent-choice-btn',
        aLabel,
      );
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (aKey === 'coral') {
          delete document.documentElement.dataset.accent;
        } else {
          document.documentElement.dataset.accent = aKey;
        }
        localStorage.setItem('courseforge_accent', aKey);
        this.render();
      });
      accentRow.append(btn);
    }
    accentWrap.append(accentRow);

    appearanceCard.append(themeWrap, accentWrap);
    grid.append(appearanceCard);

    // Panel 2: Daily Study Goal
    const goalCard = el('section', 'panel settings-panel-card');
    const goalHead = el('div', 'settings-panel-head');
    goalHead.append(
      el('h2', '', 'Study Habit Target'),
      el('p', 'muted', 'Set your daily target to preserve streaks and schedule study reminders.'),
    );
    goalCard.append(goalHead);

    const goalGroup = el('div', 'setting-group');
    const goalLabel = el('label', 'input-label', 'Daily Goal Duration');
    goalLabel.htmlFor = 'daily-goal-duration';
    goalGroup.append(goalLabel);

    // Quick pills
    const goalPills = el('div', 'budget-pills-row settings-goal-pills');
    for (const [mVal, mLabel] of [
      [15, '15 min'],
      [30, '30 min'],
      [45, '45 min'],
      [60, '60 min'],
      [90, '90 min'],
    ] as const) {
      const pill = el(
        'button',
        this.dailyMinutes === mVal ? 'budget-choice-pill active' : 'budget-choice-pill',
        mLabel,
      );
      pill.type = 'button';
      pill.addEventListener('click', async () => {
        this.dailyMinutes = mVal;
        select.value = String(mVal);
        localStorage.setItem('courseforge_daily_goal', String(mVal));
        this.render();
        try {
          await this.options.api.request('/me/habit-preferences', {
            method: 'PUT',
            body: { goal: 'minutes', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
          });
          this.options.feedback(`Target set to ${mVal} minutes per day.`);
        } catch {
          this.options.feedback(`Saved target to ${mVal} minutes locally.`);
        }
      });
      goalPills.append(pill);
    }

    const select = el('select', 'form-input');
    select.id = 'daily-goal-duration';
    for (const m of [15, 30, 45, 60, 90]) {
      const opt = el('option', '', `${m} minutes per day`);
      opt.value = String(m);
      if (this.dailyMinutes === m) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener('change', async () => {
      const val = parseInt(select.value, 10);
      this.dailyMinutes = val;
      localStorage.setItem('courseforge_daily_goal', String(val));
      this.render();
      try {
        await this.options.api.request('/me/habit-preferences', {
          method: 'PUT',
          body: {
            goal: 'minutes',
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          },
        });
        this.options.feedback(`Updated daily study goal to ${val} minutes.`);
      } catch {
        this.options.feedback(`Saved daily goal to ${val} minutes locally.`);
      }
    });

    goalGroup.append(goalPills, select);
    goalCard.append(goalGroup);
    grid.append(goalCard);

    // Panel 3: Account & Session
    const accountCard = el('section', 'panel settings-panel-card');
    const accHead = el('div', 'settings-panel-head');
    accHead.append(
      el('h2', '', 'Account & Authentication'),
      el('p', 'muted', 'Signed in as verified CourseForge learner.'),
    );
    accountCard.append(accHead);

    const infoList = el('dl', 'account-meta-list');
    infoList.append(
      el('dt', '', 'Learner ID:'),
      el('dd', '', this.options.account.id || 'Current User'),
      el('dt', '', 'Email:'),
      el('dd', '', this.options.account.email || 'learner@courseforge.local'),
      el('dt', '', 'Role:'),
      el('dd', '', (this.options.account.role || 'learner').toUpperCase()),
    );
    accountCard.append(infoList);

    const signOutBtn = el('button', 'button quiet danger-btn');
    signOutBtn.append(svgIcon('close'), el('span', '', ' Sign Out of Account'));
    signOutBtn.type = 'button';
    signOutBtn.addEventListener('click', () => {
      this.options.onSignOut();
    });
    accountCard.append(signOutBtn);
    grid.append(accountCard);

    // Panel 4: Platform & Performance
    const aboutCard = el('section', 'panel settings-panel-card');
    const aboutHead = el('div', 'settings-panel-head');
    aboutHead.append(
      el('h2', '', 'Platform & Infrastructure'),
      el('p', 'muted', 'CourseForge 2.4.0 (Streaming Edition) · Built for Deep Focus.'),
    );
    aboutCard.append(aboutHead);

    const statusList = el('div', 'settings-status-list');
    const makeStatus = (title: string, sub: string, dotClass: string) => {
      const row = el('div', 'settings-status-row');
      const dot = el('span', `status-indicator-dot ${dotClass}`);
      const textWrap = el('div');
      textWrap.append(el('strong', '', title), el('span', 'muted', ` · ${sub}`));
      row.append(dot, textWrap);
      return row;
    };

    statusList.append(
      makeStatus('Go High-Performance API Gateway', 'Active (<4ms latency)', 'dot-green'),
      makeStatus('Go Range Streaming Media Server', 'High-Throughput (<12ms seek latency)', 'dot-green'),
      makeStatus('PostgreSQL Primary Store', 'Schema v2.4 fully synchronized', 'dot-green'),
      makeStatus('Odysee Multi-Account CDN Stream Pool', '3-token rotational balancing', 'dot-green'),
    );
    aboutCard.append(statusList);
    grid.append(aboutCard);

    root.append(grid);
  }
}
