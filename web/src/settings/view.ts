import { svgIcon } from '../icons';
import type { AuthResponse } from '../contracts';
import { ApiClient } from '../api';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
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

    void this.options.api.request<{ preferences: { daily_minutes?: number } }>('/planner/preferences', { signal })
      .then(res => {
        if (res?.preferences?.daily_minutes) {
          this.dailyMinutes = res.preferences.daily_minutes;
          this.render();
        }
      }).catch(() => {});
  }

  deactivate(): void {
    this.options.root.hidden = true;
    this.options.root.replaceChildren();
  }

  render(): void {
    const root = this.options.root;
    root.replaceChildren();

    const pageHead = el('div', 'page-heading');
    const headText = el('div');
    headText.append(
      el('span', 'eyebrow', 'PREFERENCES & PROFILE'),
      el('h1', '', 'Settings'),
      el('p', 'muted', 'Customize your learning studio, daily focus targets, and appearance.'),
    );
    pageHead.append(headText);
    root.append(pageHead);

    const grid = el('div', 'settings-grid');

    // Panel 1: Appearance
    const appearanceCard = el('section', 'panel settings-panel-card');
    appearanceCard.append(
      el('h2', '', 'Appearance & Theme'),
      el('p', 'muted', 'Select your preferred visual style and high-contrast accent.'),
    );

    const themeWrap = el('div', 'setting-group');
    themeWrap.append(el('label', 'input-label', 'Color Scheme'));
    const themeRow = el('div', 'theme-toggle-row');
    const currentTheme = document.documentElement.dataset.theme || localStorage.getItem('courseforge_theme') || 'dark';

    for (const [tKey, tLabel] of [['dark', 'Dark (Default)'], ['light', 'Light'], ['system', 'System']] as const) {
      const btn = el('button', currentTheme === tKey ? 'button theme-choice-btn active' : 'button quiet theme-choice-btn', tLabel);
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
    accentWrap.append(el('label', 'input-label', 'Accent Highlight'));
    const accentRow = el('div', 'accent-toggle-row');
    const currentAccent = document.documentElement.dataset.accent || localStorage.getItem('courseforge_accent') || 'indigo';

    for (const [aKey, aLabel] of [['indigo', 'Indigo (Default)'], ['teal', 'Teal Glow'], ['rose', 'Crimson Rose']] as const) {
      const btn = el('button', currentAccent === aKey ? 'button accent-choice-btn active' : 'button quiet accent-choice-btn', aLabel);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        document.documentElement.dataset.accent = aKey;
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
    goalCard.append(
      el('h2', '', 'Study Habit Target'),
      el('p', 'muted', 'Set a daily focus time target to keep your learning streak active.'),
    );

    const goalGroup = el('div', 'setting-group');
    const select = el('select', 'form-input');
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

    goalGroup.append(el('label', 'input-label', 'Daily Goal Duration'), select);
    goalCard.append(goalGroup);
    grid.append(goalCard);

    // Panel 3: Account & Session
    const accountCard = el('section', 'panel settings-panel-card');
    accountCard.append(
      el('h2', '', 'Account & Authentication'),
      el('p', 'muted', 'Signed in as verified CourseForge learner.'),
    );

    const infoList = el('dl', 'account-meta-list');
    infoList.append(
      el('dt', '', 'Learner ID:'), el('dd', '', this.options.account.id || 'Current User'),
      el('dt', '', 'Email:'), el('dd', '', this.options.account.email || 'learner@courseforge.local'),
      el('dt', '', 'Role:'), el('dd', '', (this.options.account.role || 'learner').toUpperCase()),
    );
    accountCard.append(infoList);

    const signOutBtn = el('button', 'button quiet danger-btn');
    signOutBtn.append(svgIcon('close'), ' Sign Out of Account');
    signOutBtn.type = 'button';
    signOutBtn.addEventListener('click', () => {
      this.options.onSignOut();
    });
    accountCard.append(signOutBtn);
    grid.append(accountCard);

    // Panel 4: About Platform
    const aboutCard = el('section', 'panel settings-panel-card');
    aboutCard.append(
      el('h2', '', 'About CourseForge'),
      el('p', 'muted', 'Version 2.4.0 (Streaming Edition) · Built for Deep Focus.'),
      el('p', 'settings-description-text', 'CourseForge provides luxury high-speed engineering courses with source-verified video streams, intelligent local AI tutoring, interactive quizzes, synchronized transcripts, and verifiable completion certificates.'),
    );
    grid.append(aboutCard);

    root.append(grid);
  }
}
