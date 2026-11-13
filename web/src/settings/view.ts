import { svgIcon } from '../icons';
import type { AuthResponse, PlayerPreferences } from '../contracts';
import type { ApiClient } from '../api';
import { errorMessage, isAbort } from '../api';
import type { AiDependencyStatus } from '../ai/status';
import { el } from '../components';
import { inlineSkeleton } from '../ui/skeleton';
import { settingsAiPanelCopy, settingsPrivacyCopy } from './status';

export interface SettingsViewOptions {
  root: HTMLElement;
  api: ApiClient;
  account: AuthResponse['user'];
  onSignOut: () => void;
  feedback: (msg: string, error?: boolean) => void;
}

export class SettingsView {
  private dailyMinutes = 30;
  private plannerRevision = 0;
  private playerPrefs: PlayerPreferences = { autoplay: false, speed: 1 };
  private prefsLoading = false;
  private prefsError: string | null = null;
  private aiStatus: AiDependencyStatus | null = null;
  private aiStatusError: string | null = null;

  private get goalKey(): string | null {
    const uid = this.options.account.id;
    return uid ? `courseforge_daily_goal_${uid}` : null;
  }

  constructor(private readonly options: SettingsViewOptions) {
    try {
      localStorage.removeItem('courseforge_daily_goal_undefined');
    } catch {}
    const savedGoal = this.goalKey ? localStorage.getItem(this.goalKey) : null;
    if (savedGoal) {
      const parsed = parseInt(savedGoal, 10);
      if (!isNaN(parsed) && parsed > 0) this.dailyMinutes = parsed;
    }
  }

  activate(signal: AbortSignal): void {
    this.options.root.hidden = false;
    this.prefsLoading = true;
    this.prefsError = null;
    this.render();

    void Promise.allSettled([
      this.options.api.request<{
        daily_minutes?: number;
        revision?: number;
        preferences?: { daily_minutes?: number; revision?: number };
      }>('/planner/preferences', { signal }),
      this.options.api.preferences(signal),
      this.options.api.aiStatus(signal),
    ]).then(([plannerRes, playerRes, aiRes]) => {
      if (signal.aborted) return;
      if (plannerRes.status === 'fulfilled') {
        const prefs = plannerRes.value;
        const minutes = prefs.daily_minutes ?? prefs.preferences?.daily_minutes;
        const revision = prefs.revision ?? prefs.preferences?.revision;
        if (typeof minutes === 'number' && minutes > 0) this.dailyMinutes = minutes;
        if (typeof revision === 'number' && Number.isFinite(revision)) this.plannerRevision = revision;
      }
      if (playerRes.status === 'fulfilled') {
        this.playerPrefs = {
          autoplay: playerRes.value.autoplay === true,
          speed:
            Number.isFinite(playerRes.value.speed) && playerRes.value.speed >= 0.5 && playerRes.value.speed <= 3
              ? playerRes.value.speed
              : 1,
        };
        this.prefsError = null;
      } else if (!isAbort(playerRes.reason)) {
        this.prefsError = errorMessage(playerRes.reason);
      }
      if (aiRes.status === 'fulfilled') {
        this.aiStatus = aiRes.value;
        this.aiStatusError = null;
      } else if (!isAbort(aiRes.reason)) {
        this.aiStatus = null;
        this.aiStatusError = errorMessage(aiRes.reason);
      }
      this.prefsLoading = false;
      this.render();
    });
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
      el('span', 'eyebrow', 'ACCOUNT & WORKSPACE PREFERENCES'),
      el('h1', 'page-title', 'Settings'),
      el(
        'p',
        'muted page-subtitle',
        'Theme, player defaults, study goals, and account session. Status rows only reflect measured preferences — not invented latency.',
      ),
    );
    pageHead.append(headText);
    root.append(pageHead);

    const grid = el('div', 'settings-grid');

    // Panel 1: Appearance & Theme
    const appearanceCard = el('section', 'panel settings-panel-card');
    const appHead = el('div', 'settings-panel-head');
    appHead.append(
      el('h2', '', 'Appearance & Theme'),
      el('p', 'muted', 'Stored locally in this browser.'),
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

    // Panel 2: Video player defaults (authorized API)
    const playerCard = el('section', 'panel settings-panel-card');
    const playerHead = el('div', 'settings-panel-head');
    playerHead.append(
      el('h2', '', 'Video Player Defaults'),
      el('p', 'muted', 'Saved to your account when the playback preferences API acknowledges the write.'),
    );
    playerCard.append(playerHead);

    if (this.prefsLoading) {
      playerCard.append(inlineSkeleton('Loading player preferences…'));
    } else if (this.prefsError) {
      playerCard.append(el('p', 'planning-status-alert', `Could not load player preferences: ${this.prefsError}`));
    } else {
      const autoplayGroup = el('div', 'setting-group');
      const autoplayLabel = el('label', 'input-label');
      const autoplayCheck = document.createElement('input');
      autoplayCheck.type = 'checkbox';
      autoplayCheck.checked = this.playerPrefs.autoplay;
      autoplayCheck.id = 'settings-autoplay';
      autoplayLabel.htmlFor = 'settings-autoplay';
      autoplayLabel.append(autoplayCheck, document.createTextNode(' Autoplay next lecture after end'));
      autoplayCheck.addEventListener('change', async () => {
        const next = { ...this.playerPrefs, autoplay: autoplayCheck.checked };
        try {
          this.playerPrefs = await this.options.api.savePreferences(next, new AbortController().signal);
          this.options.feedback(
            this.playerPrefs.autoplay ? 'Autoplay enabled after durable save.' : 'Autoplay disabled after durable save.',
          );
          this.render();
        } catch (err) {
          autoplayCheck.checked = this.playerPrefs.autoplay;
          this.options.feedback(errorMessage(err), true);
        }
      });
      autoplayGroup.append(autoplayLabel);

      const speedGroup = el('div', 'setting-group');
      const speedLabel = el('label', 'input-label', 'Default Playback Speed');
      speedLabel.htmlFor = 'settings-speed';
      const speedSelect = el('select', 'form-input');
      speedSelect.id = 'settings-speed';
      for (const speed of [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
        const opt = el('option', '', `${speed}×`);
        opt.value = String(speed);
        if (this.playerPrefs.speed === speed) opt.selected = true;
        speedSelect.append(opt);
      }
      speedSelect.addEventListener('change', async () => {
        const speed = Number(speedSelect.value);
        const next = { ...this.playerPrefs, speed };
        try {
          this.playerPrefs = await this.options.api.savePreferences(next, new AbortController().signal);
          this.options.feedback(`Default speed set to ${this.playerPrefs.speed}×.`);
          this.render();
        } catch (err) {
          speedSelect.value = String(this.playerPrefs.speed);
          this.options.feedback(errorMessage(err), true);
        }
      });
      speedGroup.append(speedLabel, speedSelect);
      playerCard.append(autoplayGroup, speedGroup);
    }
    grid.append(playerCard);

    // Panel 3: Daily Study Goal
    const goalCard = el('section', 'panel settings-panel-card');
    const goalHead = el('div', 'settings-panel-head');
    goalHead.append(
      el('h2', '', 'Study Habit Target'),
      el('p', 'muted', 'Local fallback is used when habit preferences cannot be saved remotely.'),
    );
    goalCard.append(goalHead);

    const goalGroup = el('div', 'setting-group');
    const goalLabel = el('label', 'input-label', 'Daily Goal Duration');
    goalLabel.htmlFor = 'daily-goal-duration';
    goalGroup.append(goalLabel);

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
        if (this.goalKey) localStorage.setItem(this.goalKey, String(mVal));
        this.render();
        try {
          const saved = await this.options.api.request<{ daily_minutes: number; revision: number }>(
            '/planner/preferences',
            {
              method: 'PUT',
              body: {
                daily_minutes: mVal,
                path_id: null,
                expected_revision: this.plannerRevision,
              },
              idempotencyKey: crypto.randomUUID(),
            },
          );
          if (typeof saved.revision === 'number') this.plannerRevision = saved.revision;
          if (typeof saved.daily_minutes === 'number') this.dailyMinutes = saved.daily_minutes;
          this.options.feedback(`Target set to ${this.dailyMinutes} minutes per day.`);
          this.render();
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
      if (this.goalKey) localStorage.setItem(this.goalKey, String(val));
      this.render();
      try {
        const saved = await this.options.api.request<{ daily_minutes: number; revision: number }>(
          '/planner/preferences',
          {
            method: 'PUT',
            body: {
              daily_minutes: val,
              path_id: null,
              expected_revision: this.plannerRevision,
            },
            idempotencyKey: crypto.randomUUID(),
          },
        );
        if (typeof saved.revision === 'number') this.plannerRevision = saved.revision;
        if (typeof saved.daily_minutes === 'number') this.dailyMinutes = saved.daily_minutes;
        this.options.feedback(`Updated daily study goal to ${this.dailyMinutes} minutes.`);
        this.render();
      } catch {
        this.options.feedback(`Saved daily goal to ${val} minutes locally.`);
      }
    });

    goalGroup.append(goalPills, select);
    goalCard.append(goalGroup);
    grid.append(goalCard);

    // Panel 4: Account & Session
    const accountCard = el('section', 'panel settings-panel-card');
    const accHead = el('div', 'settings-panel-head');
    accHead.append(
      el('h2', '', 'Account & Authentication'),
      el('p', 'muted', 'Signed-in learner identity from the auth session.'),
    );
    accountCard.append(accHead);

    const infoList = el('dl', 'account-meta-list');
    infoList.append(
      el('dt', '', 'Learner ID:'),
      el('dd', '', this.options.account.id || '—'),
      el('dt', '', 'Email:'),
      el('dd', '', this.options.account.email || '—'),
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

    // Panel 5: Local AI status (measured; never starts Ollama)
    const aiCard = el('section', 'panel settings-panel-card');
    const aiHead = el('div', 'settings-panel-head');
    aiHead.append(
      el('h2', '', 'Local AI companion'),
      el('p', 'muted', 'Read-only status from /ai/status. Ollama is never started from Settings.'),
    );
    aiCard.append(aiHead);
    if (this.prefsLoading) {
      aiCard.append(inlineSkeleton('Checking AI status…'));
    } else if (this.aiStatusError) {
      aiCard.append(el('p', 'planning-status-alert', `Could not read AI status: ${this.aiStatusError}`));
    } else {
      const copy = settingsAiPanelCopy(this.aiStatus);
      aiCard.append(
        el('p', copy.ready ? 'settings-ai-ready' : 'planning-status-alert', copy.title),
        el('p', 'muted', copy.description),
      );
      if (this.aiStatus) {
        const meta = el('dl', 'account-meta-list');
        meta.append(
          el('dt', '', 'Chat model:'),
          el('dd', '', this.aiStatus.ollama_chat_model || '—'),
          el('dt', '', 'Indexed chunks:'),
          el('dd', '', String(this.aiStatus.transcript_chunks)),
          el('dt', '', 'pgvector:'),
          el('dd', '', this.aiStatus.pgvector_active ? 'active' : 'inactive'),
        );
        aiCard.append(meta);
      }
    }
    grid.append(aiCard);

    // Panel 6: Privacy / honesty notes
    const aboutCard = el('section', 'panel settings-panel-card');
    const aboutHead = el('div', 'settings-panel-head');
    aboutHead.append(el('h2', '', 'Privacy & workspace notes'), el('p', 'muted', settingsPrivacyCopy()));
    aboutCard.append(aboutHead);
    grid.append(aboutCard);

    root.append(grid);
  }
}
