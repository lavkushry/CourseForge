import { svgIcon } from '../icons';
import { ApiClient, errorMessage, isAbort } from '../api';
import { CareerApi } from './api';
import { emptyResumeDraft } from './contracts';
import './style.css';
import type {
  AlertSource,
  AnalyticsReport,
  Application,
  AppliedJob,
  BoostStatus,
  BottleneckAlert,
  CandidateProfile,
  CareerNotification,
  Company,
  ConfirmedFact,
  CSVImportReport,
  DailyPacing,
  EngineReadiness,
  HiringProfile,
  MatchResult,
  PlanTodayResponse,
  PlatformAuthRequirement,
  RecruiterLead,
  ReferralContact,
  ReferralDraft,
  ResumeDocument,
  ResumeVersion,
  RoleTrack,
  TemplateInfo,
} from './contracts';
import { renderAlerts } from './panel-alerts';
import { renderAnalytics } from './panel-analytics';
import { renderCompanies } from './panel-companies';
import { renderFacts } from './panel-facts';
import { renderMatch } from './panel-match';
import { renderReferrals } from './panel-referrals';
import { renderResumeStudio } from './panel-resume';
import { renderTracker } from './panel-tracker';
import { renderTracks } from './panel-tracks';
import type { CareerStudioHost, CareerViewOptions } from './view-host';

export type { CareerViewOptions } from './view-host';

type StudioTab =
  | 'story'
  | 'resume'
  | 'match'
  | 'companies'
  | 'tracks'
  | 'tracker'
  | 'referrals'
  | 'analytics'
  | 'alerts'
  | 'all';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export class CareerView implements CareerStudioHost {
  readonly career: CareerApi;
  private activeTab: 'goal' | 'plan' | 'boost' | 'ledger' = 'goal';
  private activeStudioView: StudioTab | null = null;
  private loading = false;
  private actionInProgress = false;
  private bannerMessage: string | null = null;
  private checkedTasks = new Set<string>();
  private abortController: AbortController | null = null;

  // Cached Autonomous Engine Domain State
  private boostStatus: BoostStatus | null = null;
  private pacing: DailyPacing | null = null;
  private planToday: PlanTodayResponse | null = null;
  private leads: RecruiterLead[] = [];
  private jobs: AppliedJob[] = [];
  private jobsTotal = 0;
  private readiness: EngineReadiness | null = null;
  private setupPanelOpen = false;
  private resumePasteDraft = '';
  private ledgerSearch = '';
  private ledgerPlatformFilter = '';
  private keyboardHandler: ((e: KeyboardEvent) => void) | null = null;

  // CareerStudioHost State (9 Studio Panels)
  tracks: RoleTrack[] = [];
  companies: Company[] = [];
  facts: ConfirmedFact[] = [];
  applications: Application[] = [];
  templates: TemplateInfo[] = [];
  versions: ResumeVersion[] = [];
  contacts: ReferralContact[] = [];
  analytics: AnalyticsReport | null = null;
  appImportReport: CSVImportReport | null = null;
  contactImportReport: CSVImportReport | null = null;
  referralMatches: ReferralContact[] = [];
  referralDraft: ReferralDraft | null = null;
  alertSources: AlertSource[] = [];
  notifications: CareerNotification[] = [];
  selectedTrackId = '';
  selectedCompanyId = '';
  selectedAppId = '';
  selectedTemplateId = 'ats_classic';
  draft: ResumeDocument = emptyResumeDraft();
  targetSkillsRaw = '';
  profile: HiringProfile | null = null;
  match: MatchResult | null = null;
  latestVersion: ResumeVersion | null = null;
  signal: AbortSignal | null = null;
  busy = false;

  constructor(readonly options: CareerViewOptions) {
    this.career = new CareerApi(options.api);
    this.loadCheckedTasks();
  }

  private get userStoragePrefix(): string | null {
    const uid = this.options.account?.id || this.readiness?.profile?.user_id;
    if (!uid) return null;
    const day = new Date().toISOString().slice(0, 10);
    return `courseforge_career_tasks_${uid}_${day}`;
  }

  private loadCheckedTasks(): void {
    // Purge pre-isolation shared buckets: the old fallback wrote checklists
    // under courseforge_career_tasks_user_<day>, shared by every user.
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('courseforge_career_tasks_user_')) localStorage.removeItem(k);
      }
    } catch {}
    if (!this.userStoragePrefix) return;
    try {
      const raw = localStorage.getItem(this.userStoragePrefix);
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        if (Array.isArray(arr)) {
          this.checkedTasks = new Set(arr);
        }
      }
    } catch {
      this.checkedTasks = new Set();
    }
  }

  private saveCheckedTasks(): void {
    if (!this.userStoragePrefix) return;
    try {
      localStorage.setItem(this.userStoragePrefix, JSON.stringify([...this.checkedTasks]));
    } catch {}
  }

  activate(signal?: AbortSignal): void {
    this.options.root.hidden = false;
    this.signal = signal ?? null;
    this.attachKeyboardShortcuts();
    void this.init();
  }

  private attachKeyboardShortcuts(): void {
    if (this.keyboardHandler) {
      window.removeEventListener('keydown', this.keyboardHandler);
    }
    this.keyboardHandler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === '1' || e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        this.setTab('goal');
      } else if (e.key === '2' || e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        this.setTab('plan');
      } else if (e.key === '3' || e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        this.setTab('boost');
      } else if (e.key === '4' || e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        this.setTab('ledger');
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        void this.triggerBump();
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        void this.refreshAll();
      } else if (e.key === 'Escape') {
        if (this.setupPanelOpen) {
          e.preventDefault();
          this.setupPanelOpen = false;
          this.render();
        } else if (this.bannerMessage) {
          e.preventDefault();
          this.bannerMessage = null;
          this.render();
        }
      }
    };
    window.addEventListener('keydown', this.keyboardHandler);
  }

  async init(): Promise<void> {
    this.abortController?.abort();
    this.abortController = new AbortController();
    this.signal = this.abortController.signal;
    await this.refreshAll();
  }

  deactivate(): void {
    if (this.keyboardHandler) {
      window.removeEventListener('keydown', this.keyboardHandler);
      this.keyboardHandler = null;
    }
    this.abortController?.abort();
    this.abortController = null;
    this.signal = null;
    this.options.root.hidden = true;
    this.options.root.replaceChildren();
  }

  private notify(msg: string, isError = false): void {
    this.bannerMessage = msg;
    if (this.options.feedback) {
      this.options.feedback(msg, isError);
    }
    this.render();
  }

  private setTab(tab: 'goal' | 'plan' | 'boost' | 'ledger'): void {
    this.activeStudioView = null;
    this.activeTab = tab;
    this.render();
  }

  private setStudioView(view: StudioTab): void {
    this.activeStudioView = view;
    this.render();
  }

  async reload(): Promise<void> {
    await this.refreshAll();
  }

  async loadSelectedApplication(): Promise<void> {
    const app = this.applications.find(a => a.id === this.selectedAppId);
    if (!app) {
      const candidateName = this.readiness?.profile?.full_name || this.options.account?.name || '';
      const candidateEmail = this.readiness?.profile?.email || this.options.account?.email || '';
      const roleTitle =
        this.tracks.find(t => t.id === this.selectedTrackId)?.title ||
        this.readiness?.profile?.target_role ||
        '';
      this.draft = {
        ...emptyResumeDraft(roleTitle),
        full_name: candidateName,
        email: candidateEmail,
        phone: this.readiness?.profile?.phone || '',
        location: this.readiness?.profile?.preferred_locations?.[0] || 'Bengaluru',
        skills: [...(this.readiness?.profile?.primary_skills || [])],
      };
      this.targetSkillsRaw = (this.readiness?.profile?.primary_skills || []).join(', ');
      this.versions = [];
      this.latestVersion = null;
      return;
    }
    this.draft = {
      ...emptyResumeDraft(),
      ...app.resume_draft,
      skills: [...app.resume_draft.skills],
      experience: [...app.resume_draft.experience],
      education: [...app.resume_draft.education],
    };
    this.targetSkillsRaw = app.target_skills.join(', ');
    if (!this.draft.title) this.draft.title = app.title;
    try {
      const versions = await this.career.versions(app.id, this.signal ?? undefined);
      this.versions = versions.versions;
      this.latestVersion = this.versions[0] ?? null;
    } catch {
      this.versions = [];
      this.latestVersion = null;
    }
  }

  private async refreshAll(): Promise<void> {
    this.loading = true;
    this.render();

    const sig = this.abortController?.signal;
    try {
      const [
        pacingRes,
        boostRes,
        planRes,
        leadsRes,
        jobsRes,
        readinessRes,
        tracksRes,
        companiesRes,
        factsRes,
        appsRes,
        templatesRes,
        contactsRes,
        analyticsRes,
        sourcesRes,
        notifsRes,
      ] = await Promise.allSettled([
        this.options.api.request<DailyPacing>('/career/goal/pacing', sig ? { signal: sig } : {}),
        this.options.api.request<BoostStatus>('/career/boost/status', sig ? { signal: sig } : {}),
        this.options.api.request<PlanTodayResponse>('/career/plan/today', sig ? { signal: sig } : {}),
        this.options.api.request<{ leads: RecruiterLead[] }>('/career/goal/leads', sig ? { signal: sig } : {}),
        this.options.api.request<{ jobs: AppliedJob[]; total: number }>(
          '/career/jobs?limit=50',
          sig ? { signal: sig } : {},
        ),
        this.options.api.request<EngineReadiness>('/career/engine/readiness', sig ? { signal: sig } : {}),
        this.career.roleTracks(sig),
        this.career.companies(sig),
        this.career.facts(sig),
        this.career.applications(sig),
        this.career.templates(sig),
        this.career.contacts(sig),
        this.career.analytics(sig),
        this.career.alertSources(sig),
        this.career.notifications(false, sig),
      ]);

      if (pacingRes.status === 'fulfilled') this.pacing = pacingRes.value;
      if (boostRes.status === 'fulfilled') this.boostStatus = boostRes.value;
      if (planRes.status === 'fulfilled') this.planToday = planRes.value;
      if (leadsRes.status === 'fulfilled') this.leads = leadsRes.value.leads || [];
      if (jobsRes.status === 'fulfilled') {
        this.jobs = jobsRes.value.jobs || [];
        this.jobsTotal = jobsRes.value.total || this.jobs.length;
      }
      if (readinessRes.status === 'fulfilled') {
        this.readiness = readinessRes.value;
      }

      if (tracksRes.status === 'fulfilled') this.tracks = tracksRes.value.tracks || [];
      if (companiesRes.status === 'fulfilled') this.companies = companiesRes.value.companies || [];
      if (factsRes.status === 'fulfilled') this.facts = factsRes.value.facts || [];
      if (appsRes.status === 'fulfilled') this.applications = appsRes.value.applications || [];
      if (templatesRes.status === 'fulfilled') this.templates = templatesRes.value.templates || [];
      if (contactsRes.status === 'fulfilled') this.contacts = contactsRes.value.contacts || [];
      if (analyticsRes.status === 'fulfilled') this.analytics = analyticsRes.value;
      if (sourcesRes.status === 'fulfilled') this.alertSources = sourcesRes.value.sources || [];
      if (notifsRes.status === 'fulfilled') this.notifications = notifsRes.value.notifications || [];

      if (!this.selectedTrackId) {
        this.selectedTrackId = this.readiness?.profile?.primary_track_id || this.tracks[0]?.id || 'backend';
      }
      if (!this.selectedCompanyId && this.companies[0]) {
        this.selectedCompanyId = this.companies[0].id;
      }
      if (!this.selectedAppId && this.applications[0]) {
        this.selectedAppId = this.applications[0].id;
      }
      if (!this.selectedTemplateId && this.templates[0]) {
        this.selectedTemplateId = this.templates[0].id;
      }
      if (this.selectedCompanyId) {
        try {
          this.profile = await this.career.hiringProfile(this.selectedCompanyId, sig);
        } catch {
          this.profile = null;
        }
      } else {
        this.profile = null;
      }
      await this.loadSelectedApplication();
      this.loadCheckedTasks();
    } catch (err) {
      if (!isAbort(err)) {
        this.notify(errorMessage(err), true);
      }
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async triggerBump(): Promise<void> {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    this.notify('Executing Resdex profile freshness bump...');

    try {
      const res = await this.options.api.request<{ success: boolean; message: string }>('/career/boost/bump', {
        method: 'POST',
        body: { dry_run: true },
      });
      this.notify(res.message || 'Resdex profile bumped to Active Today!');
      await this.refreshAll();
    } catch (err) {
      this.notify(`Bump failed: ${errorMessage(err)}`, true);
    } finally {
      this.actionInProgress = false;
      this.render();
    }
  }

  private async executeBlock(blockId: 1 | 2 | 3): Promise<void> {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    this.notify(`Running Daily Routine Block ${blockId}...`);

    try {
      const res = await this.options.api.request<{ message: string; tasks_completed: string[] }>(
        '/career/plan/execute-block',
        {
          method: 'POST',
          body: { block: blockId, dry_run: true },
        },
      );
      this.notify(`${res.message} (${(res.tasks_completed || []).join(', ')})`);
      await this.refreshAll();
    } catch (err) {
      this.notify(`Block ${blockId} execution failed: ${errorMessage(err)}`, true);
    } finally {
      this.actionInProgress = false;
      this.render();
    }
  }

  private async updateLeadStatus(leadId: string, newStatus: string): Promise<void> {
    try {
      await this.options.api.request(`/career/goal/leads/${encodeURIComponent(leadId)}/status`, {
        method: 'PUT',
        body: { status: newStatus },
      });
      this.notify(`Updated lead status to ${newStatus}`);
      await this.refreshAll();
    } catch (err) {
      this.notify(`Failed to update lead: ${errorMessage(err)}`, true);
    }
  }

  private async createLead(recruiterName: string, company: string, targetRole: string, platform: string): Promise<void> {
    if (!recruiterName.trim() || !company.trim()) {
      this.notify('Recruiter name and company are required.', true);
      return;
    }
    this.actionInProgress = true;
    try {
      await this.options.api.request('/career/goal/leads', {
        method: 'POST',
        body: {
          recruiter_name: recruiterName.trim(),
          company: company.trim(),
          target_role: targetRole.trim() || this.readiness?.profile?.target_role || 'Software Engineer',
          platform: platform || 'LinkedIn',
        },
      });
      this.notify(`Added ${recruiterName.trim()} (${company.trim()}) to your personal Recruiter CRM.`);
      await this.refreshAll();
    } catch (err) {
      this.notify(`Failed to add lead: ${errorMessage(err)}`, true);
    } finally {
      this.actionInProgress = false;
      this.render();
    }
  }

  private async uploadResumePayload(filename: string, contentBase64: string, rawText: string): Promise<void> {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    this.notify('Extracting candidate profile, role track, skills, and story facts from resume...');
    try {
      const saved = await this.options.api.request<CandidateProfile>('/career/profile/resume', {
        method: 'POST',
        body: {
          filename,
          content_base64: contentBase64,
          raw_text: rawText,
        },
      });
      this.selectedTrackId = saved.primary_track_id || this.selectedTrackId;
      this.notify(
        `Story updated for ${saved.full_name}: ${saved.target_role} (${saved.total_yoe} YOE, ${saved.notice_period_days}d notice) · Track: ${saved.primary_track_id.toUpperCase()}`,
      );
      await this.refreshAll();
    } catch (err) {
      this.notify(`Resume parsing failed: ${errorMessage(err)}`, true);
    } finally {
      this.actionInProgress = false;
      this.render();
    }
  }

  private async saveProfileOverrides(updated: CandidateProfile): Promise<void> {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    try {
      const saved = await this.options.api.request<CandidateProfile>('/career/profile', {
        method: 'PUT',
        body: updated,
      });
      this.selectedTrackId = saved.primary_track_id || this.selectedTrackId;
      this.notify(`Saved profile for ${saved.full_name} (${saved.target_role})`);
      await this.refreshAll();
    } catch (err) {
      this.notify(`Failed to save profile: ${errorMessage(err)}`, true);
    } finally {
      this.actionInProgress = false;
      this.render();
    }
  }

  private async connectPlatform(
    platform: string,
    authMethod: string,
    accountId: string,
    secretPayload: string,
  ): Promise<void> {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    try {
      await this.options.api.request('/career/auth/connect', {
        method: 'POST',
        body: {
          platform,
          auth_method: authMethod,
          account_identifier: accountId,
          secret_payload: secretPayload,
        },
      });
      this.notify(`Connected ${platform.toUpperCase()} (${authMethod}) in AES-256-GCM Vault`);
      await this.refreshAll();
    } catch (err) {
      this.notify(`Auth connection failed: ${errorMessage(err)}`, true);
    } finally {
      this.actionInProgress = false;
      this.render();
    }
  }

  private async disconnectPlatform(platform: string): Promise<void> {
    try {
      await this.options.api.request(`/career/auth/${encodeURIComponent(platform)}`, {
        method: 'DELETE',
      });
      this.notify(`Disconnected ${platform.toUpperCase()} credentials`);
      await this.refreshAll();
    } catch (err) {
      this.notify(`Disconnect failed: ${errorMessage(err)}`, true);
    }
  }

  private async startEngine(mode: 'DRY_RUN' | 'LIVE'): Promise<void> {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    this.notify(`Starting Career Engine in ${mode} mode...`);
    try {
      const res = await this.options.api.request<{ message: string }>('/career/engine/start', {
        method: 'POST',
        body: { execution_mode: mode, daily_call_target: 5 },
      });
      this.notify(res.message || 'Autonomous Career Engine is now RUNNING!');
      await this.refreshAll();
    } catch (err) {
      this.notify(`Cannot start engine: ${errorMessage(err)}`, true);
    } finally {
      this.actionInProgress = false;
      this.render();
    }
  }

  private async pauseEngine(): Promise<void> {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    try {
      const res = await this.options.api.request<{ message: string }>('/career/engine/pause', {
        method: 'POST',
        body: {},
      });
      this.notify(res.message || 'Career Engine paused.');
      await this.refreshAll();
    } catch (err) {
      this.notify(`Failed to pause engine: ${errorMessage(err)}`, true);
    } finally {
      this.actionInProgress = false;
      this.render();
    }
  }

  render(): void {
    const root = this.options.root;
    root.replaceChildren();

    const container = el('div', 'career-studio-container');

    const profile = this.readiness?.profile;
    const engine = this.readiness?.engine;
    const isRunning = engine?.engine_status === 'RUNNING';
    const userName = profile?.full_name || this.options.account?.name || 'Candidate';
    const userEmail = profile?.email || this.options.account?.email || '';
    const activeRole = profile?.target_role || 'Software Engineer';
    const activeYOE = profile?.total_yoe ?? 2.0;
    const activeNotice = profile?.notice_period_days ?? 30;
    const activeCTC = profile?.target_ctc_range || '₹18–25 LPA';
    const activeMode = engine?.execution_mode || 'DRY_RUN';

    // 1. Minimal Workspace Header (Scoped to the User's Own Story)
    const header = el('header', 'career-header');
    const titleGroup = el('div', 'career-title-group');
    const metaRow = el('div', 'career-identity-row');
    metaRow.append(
      el('span', 'career-eyebrow', `${userName.toUpperCase()} · PERSONAL CAREER WORKSPACE`),
      userEmail ? el('span', 'career-identity-chip', userEmail) : el('span', ''),
      el('span', 'career-identity-chip', `${activeYOE} YOE · ${activeNotice}d Notice · ${activeCTC}`),
      el(
        'span',
        `career-identity-chip ${activeMode === 'LIVE' ? 'chip-live' : 'chip-sandbox'}`,
        activeMode === 'LIVE' ? 'Live Portal Mode' : 'Sandbox Mode',
      ),
      el('span', 'career-identity-chip career-shortcuts-chip', '⌨️ 1-4 · R · S'),
    );
    titleGroup.append(
      metaRow,
      el('h1', 'career-title', `${activeRole} Studio`),
      el(
        'p',
        'career-subtitle',
        `${userName}'s isolated career story, confirmed facts (${this.facts.length}), tailored resumes (${this.applications.length}), recruiter CRM (${this.leads.length}), and application history (${this.jobsTotal}).`,
      ),
    );

    const actionsGroup = el('div', 'career-header-actions');

    const setupBtn = el(
      'button',
      `career-btn ${this.setupPanelOpen ? 'career-btn-primary' : 'career-btn-secondary'}`,
    );
    setupBtn.type = 'button';
    setupBtn.append(
      svgIcon('settings'),
      el('span', '', this.setupPanelOpen ? 'Hide Setup & Auth Vault' : 'Setup & Auth Vault'),
    );
    setupBtn.addEventListener('click', () => {
      this.setupPanelOpen = !this.setupPanelOpen;
      this.render();
    });

    const engineToggleBtn = el('button', `career-btn ${isRunning ? 'career-btn-secondary' : 'career-btn-primary'}`);
    engineToggleBtn.type = 'button';
    engineToggleBtn.disabled = this.actionInProgress;
    engineToggleBtn.append(
      svgIcon(isRunning ? 'close' : 'play'),
      el('span', '', isRunning ? 'Pause Engine' : 'Start Engine'),
    );
    engineToggleBtn.addEventListener('click', () => {
      if (isRunning) {
        void this.pauseEngine();
      } else {
        void this.startEngine((engine?.execution_mode as 'DRY_RUN' | 'LIVE') || 'DRY_RUN');
      }
    });

    const bumpBtn = el('button', 'career-btn career-btn-secondary');
    bumpBtn.type = 'button';
    bumpBtn.disabled = this.actionInProgress;
    bumpBtn.append(svgIcon('zap'), el('span', '', 'Resdex Bump'));
    bumpBtn.addEventListener('click', () => void this.triggerBump());

    const refreshBtn = el('button', 'career-btn career-btn-secondary');
    refreshBtn.type = 'button';
    refreshBtn.disabled = this.loading;
    refreshBtn.append(svgIcon('refresh'), el('span', '', 'Sync'));
    refreshBtn.addEventListener('click', () => void this.refreshAll());

    actionsGroup.append(setupBtn, engineToggleBtn, bumpBtn, refreshBtn);
    header.append(titleGroup, actionsGroup);
    container.append(header);

    // 2. Compact Pre-Flight Readiness & Personal Story Status Strip
    container.append(this.renderReadinessStrip());

    // 3. Collapsible Setup & Auth Vault Drawer (Resume Upload + Profile + Platform Auth Vault)
    if (this.setupPanelOpen) {
      container.append(this.renderSetupAndVaultPanel());
    }

    // 4. Toast / Status Banner
    if (this.bannerMessage) {
      const banner = el('div', 'career-toast-banner');
      banner.append(el('span', 'career-toast-text', this.bannerMessage));
      const closeBtn = el('button', 'career-toast-close', '×');
      closeBtn.type = 'button';
      closeBtn.addEventListener('click', () => {
        this.bannerMessage = null;
        this.render();
      });
      banner.append(closeBtn);
      container.append(banner);
    }

    // 5. Realistic Minimal Unified Navigation Bar with ALL Options
    const navBar = el('div', 'career-unified-nav');

    const engineNavGroup = el('div', 'career-nav-group');
    engineNavGroup.append(el('span', 'career-nav-group-label', 'ENGINE'));
    const engineTabs: Array<{ id: 'goal' | 'plan' | 'boost' | 'ledger'; label: string; count?: string }> = [
      { id: 'goal', label: 'Goal & CRM', count: `${this.pacing?.calls_scheduled_count ?? 0}/5` },
      { id: 'plan', label: 'Daily Plan', count: '3 Sprints' },
      { id: 'boost', label: 'Profile SEO', count: this.boostStatus?.active_today ? 'Active' : 'Ready' },
      { id: 'ledger', label: 'App Ledger', count: String(this.jobsTotal) },
    ];
    for (const t of engineTabs) {
      const isSelected = this.activeStudioView === null && this.activeTab === t.id;
      const btn = el('button', `career-tab-btn ${isSelected ? 'active' : ''}`);
      btn.type = 'button';
      btn.append(el('span', '', t.label));
      if (t.count) {
        btn.append(el('span', 'career-tab-count', t.count));
      }
      btn.addEventListener('click', () => this.setTab(t.id));
      engineNavGroup.append(btn);
    }

    const studioNavGroup = el('div', 'career-nav-group');
    studioNavGroup.append(el('span', 'career-nav-group-label', 'STUDIO & STORY'));
    const studioTabs: Array<{ id: StudioTab; label: string; count?: string }> = [
      { id: 'story', label: 'My Story & Facts', count: String(this.facts.length) },
      { id: 'resume', label: 'Resume & PDF', count: String(this.applications.length) },
      { id: 'match', label: 'JD Match' },
      { id: 'companies', label: 'Companies', count: String(this.companies.length) },
      { id: 'tracks', label: 'Role Tracks', count: String(this.tracks.length) },
      { id: 'tracker', label: 'Outcome Tracker', count: String(this.applications.length) },
      { id: 'referrals', label: 'Referrals', count: String(this.contacts.length) },
      { id: 'analytics', label: 'Analytics (CI)' },
      { id: 'alerts', label: 'Job Alerts', count: String(this.notifications.filter(n => !n.read_at).length || this.alertSources.length) },
      { id: 'all', label: 'All Options' },
    ];
    for (const st of studioTabs) {
      const isSelected = this.activeStudioView === st.id;
      const btn = el('button', `career-tab-btn ${isSelected ? 'active' : ''}`);
      btn.type = 'button';
      btn.append(el('span', '', st.label));
      if (st.count !== undefined) {
        btn.append(el('span', 'career-tab-count', st.count));
      }
      btn.addEventListener('click', () => this.setStudioView(st.id));
      studioNavGroup.append(btn);
    }

    navBar.append(engineNavGroup, studioNavGroup);
    container.append(navBar);

    // 6. Active Viewport Content
    const contentArea = el('div', 'career-tab-content');
    if (this.activeStudioView !== null) {
      contentArea.append(this.renderStudioViewport(this.activeStudioView));
    } else if (this.activeTab === 'goal') {
      contentArea.append(this.renderGoalTab());
    } else if (this.activeTab === 'plan') {
      contentArea.append(this.renderPlanTab());
    } else if (this.activeTab === 'boost') {
      contentArea.append(this.renderBoostTab());
    } else if (this.activeTab === 'ledger') {
      contentArea.append(this.renderLedgerTab());
    }

    container.append(contentArea);
    root.append(container);
  }

  // ============================================================================
  // STUDIO VIEWPORT: All 9 Original Career Studio Panels + Personal Story
  // ============================================================================
  private renderStudioViewport(view: StudioTab): HTMLElement {
    const wrap = el('div', 'career-studio-viewport');

    switch (view) {
      case 'story': {
        // Unified "My Story & Confirmed Facts" view: Personal Profile + Resume Extractor + Confirmed Facts
        const storyIntro = el('div', 'career-story-banner');
        const userName = this.readiness?.profile?.full_name || this.options.account?.name || 'Your';
        storyIntro.append(
          el(
            'div',
            'career-story-banner-text',
            `${userName}'s Personal Story & Ground-Truth Facts — Every resume version, bullet suggestion, screening answer, and recruiter pitch in your account is strictly isolated to your own confirmed facts and profile.`,
          ),
        );
        wrap.append(storyIntro);
        wrap.append(this.renderPersonalStoryAndProfileCard());
        wrap.append(renderFacts(this));
        break;
      }
      case 'resume': {
        wrap.append(renderResumeStudio(this));
        break;
      }
      case 'match': {
        const grid = el('div', 'career-layout');
        grid.append(renderMatch(this), renderCompanies(this));
        wrap.append(grid);
        break;
      }
      case 'companies': {
        const grid = el('div', 'career-layout');
        grid.append(renderCompanies(this), renderMatch(this));
        wrap.append(grid);
        break;
      }
      case 'tracks': {
        const grid = el('div', 'career-layout');
        grid.append(renderTracks(this), renderFacts(this));
        wrap.append(grid);
        break;
      }
      case 'tracker': {
        const grid = el('div', 'career-layout');
        grid.append(renderTracker(this), renderAnalytics(this));
        wrap.append(grid);
        break;
      }
      case 'referrals': {
        wrap.append(renderReferrals(this));
        break;
      }
      case 'analytics': {
        const grid = el('div', 'career-layout');
        grid.append(renderAnalytics(this), renderTracker(this));
        wrap.append(grid);
        break;
      }
      case 'alerts': {
        wrap.append(renderAlerts(this));
        break;
      }
      case 'all': {
        // Complete All-Options View: renders every Studio panel + Story on one unified page
        wrap.append(this.renderPersonalStoryAndProfileCard());
        const topGrid = el('div', 'career-layout');
        topGrid.append(renderTracks(this), renderCompanies(this), renderFacts(this), renderMatch(this));
        wrap.append(topGrid);
        wrap.append(renderResumeStudio(this));
        const bottomGrid = el('div', 'career-layout career-tracker-layout');
        bottomGrid.append(renderTracker(this), renderAnalytics(this), renderReferrals(this));
        wrap.append(bottomGrid);
        wrap.append(renderAlerts(this));
        break;
      }
    }

    return wrap;
  }

  private renderPersonalStoryAndProfileCard(): HTMLElement {
    const p = this.readiness?.profile;
    const card = el('section', 'career-card career-story-profile-card');
    card.append(
      el('h3', 'career-card-title', '1. Personal Career Story & Resume Auto-Extractor'),
      el(
        'p',
        'career-card-desc',
        'Upload your PDF/TXT resume or paste your experience below. CourseForge automatically extracts your role track, skills, notice period, CTC expectations, and seeds your Confirmed Facts.',
      ),
    );

    const splitGrid = el('div', 'career-setup-grid');

    // Left: Resume Upload & Paste
    const uploadCol = el('div', 'career-setup-pane');
    const uploadDrop = el('div', 'career-upload-dropzone');
    const fileInput = el('input', 'career-file-input');
    fileInput.type = 'file';
    fileInput.accept = '.pdf,.txt,.md';
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        void this.uploadResumePayload(file.name, result, '');
      };
      reader.readAsDataURL(file);
    });

    const currentResumeLabel = p?.resume_filename
      ? `Active Resume: ${p.resume_filename}`
      : 'No resume uploaded yet — upload your PDF/TXT to personalize your story';
    uploadDrop.append(
      el('div', 'career-upload-label', currentResumeLabel),
      el('p', 'career-upload-hint', 'Select a .pdf or .txt resume file (max 10 MB)'),
      fileInput,
    );

    const pasteArea = el('textarea', 'career-textarea');
    pasteArea.rows = 4;
    pasteArea.placeholder =
      'Or paste your resume text / career summary here (e.g. "Senior Backend Engineer | 4.5 YOE | Go, Kubernetes, PostgreSQL, gRPC | 30 days notice | Expected 35 LPA...")';
    pasteArea.value = this.resumePasteDraft;
    pasteArea.addEventListener('input', () => {
      this.resumePasteDraft = pasteArea.value;
    });

    const parseTextBtn = el('button', 'career-btn career-btn-primary');
    parseTextBtn.type = 'button';
    parseTextBtn.textContent = 'Extract Story & Profile from Text';
    parseTextBtn.disabled = this.actionInProgress;
    parseTextBtn.addEventListener('click', () => {
      if (!this.resumePasteDraft.trim()) {
        this.notify('Paste at least 20 characters of resume text first.', true);
        return;
      }
      void this.uploadResumePayload('pasted_resume.txt', '', this.resumePasteDraft);
    });

    uploadCol.append(uploadDrop, pasteArea, parseTextBtn);

    // Right: Editable Ground-Truth Profile Form
    const formCol = el('div', 'career-setup-pane');
    const formGrid = el('div', 'career-profile-form-grid');
    const makeField = (label: string, val: string, placeholder = '') => {
      const wrap = el('label', 'career-field-label');
      wrap.append(el('span', '', label));
      const inp = el('input', 'career-input');
      inp.type = 'text';
      inp.value = val;
      inp.placeholder = placeholder;
      wrap.append(inp);
      return { wrap, inp };
    };

    const nameField = makeField('Full Name', p?.full_name || this.options.account?.name || '');
    const emailField = makeField('Email Address', p?.email || this.options.account?.email || '');
    const phoneField = makeField('Phone Number', p?.phone || '', '+91-9876543210');
    const roleField = makeField('Target Role', p?.target_role || 'Software Engineer');
    const trackField = makeField('Primary Track', p?.primary_track_id || 'backend', 'backend | frontend | data | ml | devops | sre');
    const yoeField = makeField('Total YOE', String(p?.total_yoe ?? 2.0));
    const noticeField = makeField('Notice Period (Days)', String(p?.notice_period_days ?? 30));
    const ctcField = makeField('Target CTC Range', p?.target_ctc_range || '₹18–25 LPA');
    const companyField = makeField('Current Company', p?.current_company || '', 'e.g. Acme Corp');
    const linkedinField = makeField('LinkedIn URL', p?.linkedin_url || '', 'https://linkedin.com/in/yourprofile');
    const skillsField = makeField(
      'Primary Skills (comma-separated)',
      (p?.primary_skills || ['Software Engineering', 'System Design', 'SQL']).join(', '),
    );
    skillsField.wrap.classList.add('career-field-full');
    const locationsField = makeField(
      'Preferred Locations (comma-separated)',
      (p?.preferred_locations || ['Bengaluru', 'Hyderabad', 'Remote']).join(', '),
    );
    locationsField.wrap.classList.add('career-field-full');

    formGrid.append(
      nameField.wrap,
      emailField.wrap,
      phoneField.wrap,
      roleField.wrap,
      trackField.wrap,
      yoeField.wrap,
      noticeField.wrap,
      ctcField.wrap,
      companyField.wrap,
      linkedinField.wrap,
      skillsField.wrap,
      locationsField.wrap,
    );

    const saveProfileBtn = el('button', 'career-btn career-btn-secondary');
    saveProfileBtn.type = 'button';
    saveProfileBtn.textContent = 'Save My Profile & Update Whitelist';
    saveProfileBtn.addEventListener('click', () => {
      const base: CandidateProfile = p || {
        user_id: this.options.account?.id || 'user',
        full_name: nameField.inp.value.trim(),
        email: emailField.inp.value.trim(),
        phone: phoneField.inp.value.trim(),
        linkedin_url: linkedinField.inp.value.trim(),
        github_url: '',
        primary_track_id: trackField.inp.value.trim() || 'backend',
        target_role: roleField.inp.value.trim(),
        secondary_roles: [],
        total_yoe: 2.0,
        relevant_yoe: 2.0,
        current_company: companyField.inp.value.trim(),
        previous_company: '',
        current_ctc_lpa: 0,
        expected_ctc_lpa: 20,
        target_ctc_range: ctcField.inp.value.trim(),
        notice_period_days: 30,
        notice_period_str: '30 Days Notice',
        primary_skills: [],
        tools: [],
        preferred_locations: ['Bengaluru', 'Hyderabad', 'Remote'],
        whitelist_headline_tokens: [],
        screening_answers: {},
        resume_filename: '',
        resume_sha256: '',
        updated_at: new Date().toISOString(),
      };
      const updatedSkills = skillsField.inp.value
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const updatedLocations = locationsField.inp.value
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      void this.saveProfileOverrides({
        ...base,
        full_name: nameField.inp.value.trim() || base.full_name,
        email: emailField.inp.value.trim() || base.email,
        phone: phoneField.inp.value.trim(),
        linkedin_url: linkedinField.inp.value.trim(),
        current_company: companyField.inp.value.trim(),
        primary_track_id: trackField.inp.value.trim() || base.primary_track_id,
        target_role: roleField.inp.value.trim() || base.target_role,
        total_yoe: parseFloat(yoeField.inp.value) || base.total_yoe,
        relevant_yoe: parseFloat(yoeField.inp.value) || base.relevant_yoe,
        notice_period_days: parseInt(noticeField.inp.value, 10) || base.notice_period_days,
        target_ctc_range: ctcField.inp.value.trim() || base.target_ctc_range,
        primary_skills: updatedSkills.length > 0 ? updatedSkills : base.primary_skills,
        preferred_locations: updatedLocations.length > 0 ? updatedLocations : base.preferred_locations,
      });
    });

    formCol.append(formGrid, saveProfileBtn);
    splitGrid.append(uploadCol, formCol);
    card.append(splitGrid);
    return card;
  }

  // ============================================================================
  // PRE-FLIGHT READINESS STRIP & PLATFORM AUTH VAULT
  // ============================================================================
  private renderReadinessStrip(): HTMLElement {
    const r = this.readiness;
    const strip = el('div', 'career-readiness-strip');

    const profileReady = r?.profile_ready ?? true;
    const authReady = r?.auth_ready ?? true;
    const whitelistReady = r?.whitelist_ready ?? true;
    const mode = r?.engine?.execution_mode || 'DRY_RUN';
    const status = r?.engine?.engine_status || 'READY';
    const hasUploadedResume = Boolean(r?.profile?.resume_filename);
    const connectedCount = (r?.platforms || []).filter(p => p.status === 'CONNECTED').length;

    const items = [
      {
        label: 'Story & Profile',
        ok: profileReady,
        detail: hasUploadedResume
          ? `${r?.profile?.full_name} · ${r?.profile?.target_role}`
          : `${r?.profile?.full_name || this.options.account?.name || 'User'} · Click "My Story & Facts" to upload resume`,
      },
      {
        label: 'Portal Auth Vault',
        ok: authReady,
        detail: `${connectedCount} Connected (${mode})`,
      },
      {
        label: 'Ground-Truth Whitelist',
        ok: whitelistReady,
        detail: whitelistReady ? 'Active Guardrails' : 'Configure Skills',
      },
      {
        label: 'Engine State',
        ok: status === 'RUNNING' || status === 'READY',
        detail: status,
      },
    ];

    for (const item of items) {
      const pill = el('div', `career-readiness-pill ${item.ok ? 'ready' : 'pending'}`);
      pill.append(
        el('span', 'readiness-dot', item.ok ? '●' : '○'),
        el('strong', 'readiness-label', `${item.label}:`),
        el('span', 'readiness-detail', item.detail),
      );
      strip.append(pill);
    }

    return strip;
  }

  private renderSetupAndVaultPanel(): HTMLElement {
    const wrap = el('section', 'career-setup-panel');
    wrap.append(this.renderPersonalStoryAndProfileCard());

    const authCard = el('div', 'career-setup-card');
    authCard.append(
      el('h3', 'career-card-title', '2. Platform Auth Vault & Execution Mode (What Auth Is Needed)'),
      el(
        'p',
        'career-card-desc',
        'Sandbox (DRY_RUN) requires zero external credentials. For LIVE execution on Naukri or LinkedIn, paste session cookies JSON or credentials below (encrypted with AES-256-GCM at rest, scoped strictly to your user ID).',
      ),
    );

    const modeRow = el('div', 'career-mode-selector');
    const curMode = (this.readiness?.engine?.execution_mode as 'DRY_RUN' | 'LIVE') || 'DRY_RUN';

    const dryRunBtn = el('button', `career-btn ${curMode === 'DRY_RUN' ? 'career-btn-primary' : 'career-btn-secondary'}`);
    dryRunBtn.type = 'button';
    dryRunBtn.textContent = 'Sandbox Mode (DRY_RUN — No Auth Needed)';
    dryRunBtn.addEventListener('click', () => void this.startEngine('DRY_RUN'));

    const liveBtn = el('button', `career-btn ${curMode === 'LIVE' ? 'career-btn-primary' : 'career-btn-secondary'}`);
    liveBtn.type = 'button';
    liveBtn.textContent = 'Live Portal Mode (Naukri / LinkedIn)';
    liveBtn.addEventListener('click', () => void this.startEngine('LIVE'));

    modeRow.append(dryRunBtn, liveBtn);
    authCard.append(modeRow);

    const reqs: PlatformAuthRequirement[] = this.readiness?.platforms || [
      {
        platform: 'naukri',
        display_name: 'Naukri.com (Resdex & 1-Click Apply)',
        recommended_method: 'cookie_json',
        required_fields: ['cookie_json', 'account_email'],
        instructions: 'Log into Naukri.com -> DevTools / Cookie-Editor -> Export as JSON -> Paste below.',
        unlocks_features: ['Resdex Profile Freshness Bump', 'High-Velocity 1-Click Apply'],
        status: 'SIMULATION',
        auth_method: 'simulation',
        account_identifier: '',
      },
      {
        platform: 'linkedin',
        display_name: 'LinkedIn (Recruiter CRM & Easy Apply)',
        recommended_method: 'cookie_json',
        required_fields: ['li_at_cookie', 'account_email'],
        instructions: 'Log into LinkedIn.com -> DevTools -> Application -> Cookies -> Copy li_at or export JSON.',
        unlocks_features: ['Recruiter CRM Outbound Pitches', 'Easy Apply'],
        status: 'SIMULATION',
        auth_method: 'simulation',
        account_identifier: '',
      },
    ];

    const reqList = el('div', 'career-auth-req-list');
    for (const req of reqs) {
      const item = el('div', 'career-auth-req-card');
      const head = el('div', 'career-auth-req-head');
      head.append(
        el('strong', 'career-auth-platform-title', req.display_name),
        el(
          'span',
          `career-status-badge status-${req.status === 'CONNECTED' ? 'CALL_SCHEDULED' : 'DRAFT_PENDING_MANUAL_SEND'}`,
          req.status,
        ),
      );

      const guide = el('div', 'career-auth-guide');
      guide.append(
        el('p', 'career-auth-needed', `Unlocks: ${(req.unlocks_features || []).join(', ')}`),
        el('p', 'career-auth-extract', `How to get it: ${req.instructions}`),
      );

      const controls = el('div', 'career-auth-controls');
      const methodSelect = el('select', 'career-select');
      for (const m of ['cookie_json', 'credentials', 'simulation'] as const) {
        const opt = el('option', '', m === 'cookie_json' ? 'Session Cookies JSON' : m === 'credentials' ? 'Email + Password' : 'Sandbox Simulation');
        opt.value = m;
        if (m === req.recommended_method) opt.selected = true;
        methodSelect.append(opt);
      }

      const accInput = el('input', 'career-input');
      accInput.type = 'text';
      accInput.placeholder = 'Account Email / Identifier';
      accInput.value = req.account_identifier || this.readiness?.profile?.email || this.options.account?.email || '';

      const secretInput = el('textarea', 'career-textarea career-secret-input');
      secretInput.rows = 2;
      secretInput.placeholder =
        'Paste Cookie JSON [{"name":"nauk_at","value":"..."}] or {"email":"...","password":"..."}';

      const btnRow = el('div', 'career-auth-btn-row');
      const connectBtn = el('button', 'career-btn career-btn-primary career-btn-sm', 'Save & Verify in Vault');
      connectBtn.type = 'button';
      connectBtn.addEventListener('click', () => {
        void this.connectPlatform(req.platform, methodSelect.value, accInput.value.trim(), secretInput.value.trim());
      });
      btnRow.append(connectBtn);

      if (req.status === 'CONNECTED') {
        const discBtn = el('button', 'career-btn career-btn-secondary career-btn-sm', 'Disconnect');
        discBtn.type = 'button';
        discBtn.addEventListener('click', () => void this.disconnectPlatform(req.platform));
        btnRow.append(discBtn);
      }

      controls.append(methodSelect, accInput, secretInput, btnRow);
      item.append(head, guide, controls);
      reqList.append(item);
    }

    authCard.append(reqList);
    wrap.append(authCard);
    return wrap;
  }

  // ============================================================================
  // TAB 1: GOAL & PACING (5-Calls North Star + 6-Stage Diagnostics + Recruiter CRM)
  // ============================================================================
  private renderGoalTab(): HTMLElement {
    const wrapper = el('div', 'career-goal-grid');

    // Top Row: Radial Pacing Gauge + Funnel Metrics
    const topRow = el('div', 'career-goal-top-row');

    const callsScheduled = this.pacing?.calls_scheduled_count ?? 0;
    const targetCalls = 5;
    const ratio = Math.min(1.0, callsScheduled / targetCalls);
    const pct = Math.round(ratio * 100);

    const gaugeCard = el('div', 'career-card career-gauge-card');
    const svgWrapper = el('div', 'career-radial-svg-wrap');

    const radius = 40;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference * (1 - ratio);
    // Pacing gauge color thresholds: emerald (>=80%), amber (>=40%), rose (<40%)
    const color = ratio >= 0.8 ? '#10b981' : ratio >= 0.4 ? '#f59e0b' : '#f43f5e';

    svgWrapper.innerHTML = `
      <svg class="career-radial-svg" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="${radius}" fill="transparent" stroke="rgba(255,255,255,0.08)" stroke-width="8" />
        <circle cx="50" cy="50" r="${radius}" fill="transparent" stroke="${color}" stroke-width="8"
          stroke-dasharray="${circumference.toFixed(2)}"
          stroke-dashoffset="${strokeDashoffset.toFixed(2)}"
          stroke-linecap="round"
          transform="rotate(-90 50 50)" />
        <text x="50" y="47" text-anchor="middle" class="career-gauge-num" fill="#f8fafc">${callsScheduled}/${targetCalls}</text>
        <text x="50" y="63" text-anchor="middle" class="career-gauge-sub" fill="#94a3b8">${pct}% Velocity</text>
      </svg>
    `;

    const gaugeInfo = el('div', 'career-gauge-info');
    gaugeInfo.append(
      el('span', 'career-badge-pill', `Pacing Date: ${this.pacing?.pacing_date || new Date().toISOString().slice(0, 10)}`),
      el('h3', '', 'North Star: 5 Recruiter Calls / Day'),
      el(
        'p',
        'career-muted',
        'Sustaining 5 daily screening calls compounds into 25 weekly conversations, 6–8 technical loops, and 2–3 competing offers.',
      ),
    );
    gaugeCard.append(svgWrapper, gaugeInfo);

    // Funnel Metrics Summary Card
    const metricsCard = el('div', 'career-card career-metrics-card');
    metricsCard.append(el('h3', 'career-card-title', 'Today’s Career Funnel Telemetry'));
    const statsGrid = el('div', 'career-stats-grid');

    const metrics = [
      { label: 'Search Appearances', val: String(this.pacing?.search_appearances ?? 0), target: 'Target: 150+/wk' },
      { label: 'Recruiter Contact Views', val: String(this.pacing?.contact_views ?? 0), target: 'Target: 5+/wk' },
      { label: 'Applications Submitted', val: String(this.pacing?.applications_count ?? 0), target: 'Target: 25/day' },
      { label: 'Recruiter Outreaches', val: String(this.pacing?.outreaches_count ?? 0), target: 'Target: 10/day' },
    ];

    for (const m of metrics) {
      const box = el('div', 'career-stat-box');
      box.append(
        el('span', 'career-stat-label', m.label),
        el('strong', 'career-stat-value', m.val),
        el('span', 'career-stat-target', m.target),
      );
      statsGrid.append(box);
    }
    metricsCard.append(statsGrid);
    topRow.append(gaugeCard, metricsCard);
    wrapper.append(topRow);

    // Middle Row: 6-Stage Diagnostic Engine
    const diagSection = el('div', 'career-card career-diagnostics-section');
    const diagHead = el('div', 'career-section-head');
    diagHead.append(
      el('h3', 'career-card-title', 'Active Bottleneck Diagnostics (6-Stage Engine)'),
      el('span', 'career-muted', 'Automated root-cause detection across visibility, CTR, velocity, and conversion'),
    );
    diagSection.append(diagHead);

    const alerts: BottleneckAlert[] = this.pacing?.active_bottlenecks || [];
    if (alerts.length === 0) {
      const okBanner = el('div', 'career-healthy-banner');
      okBanner.textContent = 'Zero bottlenecks detected — All 6 funnel stages are operating at target run-rate!';
      diagSection.append(okBanner);
    } else {
      const alertsGrid = el('div', 'career-alerts-grid');
      for (const alert of alerts) {
        const aCard = el('div', `career-alert-card severity-${alert.severity}`);
        const aTop = el('div', 'career-alert-top');
        aTop.append(
          el('span', 'career-alert-stage', alert.stage),
          el('span', `career-severity-badge badge-${alert.severity}`, alert.severity),
        );
        const aDesc = el('p', 'career-alert-desc', alert.description);
        const aActionRow = el('div', 'career-alert-action-row');
        aActionRow.append(el('div', 'career-alert-action', `Action: ${alert.action_required}`));
        aActionRow.append(this.buildDiagnosticFixButton(alert));
        aCard.append(aTop, aDesc, aActionRow);
        alertsGrid.append(aCard);
      }
      diagSection.append(alertsGrid);
    }
    wrapper.append(diagSection);

    // Bottom Row: Recruiter CRM Leads Board + Inline Add Lead Form
    const crmSection = el('div', 'career-card career-crm-section');
    const crmHead = el('div', 'career-section-head');
    crmHead.append(
      el('h3', 'career-card-title', `Recruiter Outbound CRM (${this.leads.length} Leads)`),
      el('span', 'career-muted', 'One-click copy 300-char notes tailored to your story & track 48h follow-ups'),
    );
    crmSection.append(crmHead);

    // Inline Minimal Add Lead Form
    const addLeadForm = el('form', 'career-inline-form');
    const recNameInput = el('input', 'career-input');
    recNameInput.placeholder = 'Recruiter Name (e.g. Ananya Sharma)';
    recNameInput.required = true;
    const recCompanyInput = el('input', 'career-input');
    recCompanyInput.placeholder = 'Company (e.g. Microsoft)';
    recCompanyInput.required = true;
    const recRoleInput = el('input', 'career-input');
    recRoleInput.placeholder = `Target Role (${this.readiness?.profile?.target_role || 'Software Engineer'})`;
    recRoleInput.value = this.readiness?.profile?.target_role || '';
    const addLeadBtn = el('button', 'career-btn career-btn-primary career-btn-sm', '+ Add Recruiter Lead');
    addLeadBtn.type = 'submit';
    addLeadBtn.disabled = this.actionInProgress;
    addLeadForm.append(recNameInput, recCompanyInput, recRoleInput, addLeadBtn);
    addLeadForm.addEventListener('submit', e => {
      e.preventDefault();
      void this.createLead(recNameInput.value, recCompanyInput.value, recRoleInput.value, 'LinkedIn');
    });
    crmSection.append(addLeadForm);

    if (this.leads.length === 0) {
      crmSection.append(
        el(
          'p',
          'career-empty-state',
          'No active recruiter leads in your account yet. Add a recruiter above or execute Afternoon Block 2 in the Daily Plan tab to auto-generate role-matched leads.',
        ),
      );
    } else {
      const leadsList = el('div', 'career-leads-list');
      for (const lead of this.leads) {
        const lCard = el('div', 'career-lead-row');

        const lMain = el('div', 'career-lead-main');
        const lTitleRow = el('div', 'career-lead-title-row');
        lTitleRow.append(
          el('strong', 'career-lead-name', lead.recruiter_name),
          el('span', 'career-lead-company', `@ ${lead.company}`),
          el('span', 'career-lead-role-tag', lead.target_role),
          el('span', `career-status-badge status-${lead.status}`, lead.status),
        );

        const noteText =
          lead.connection_note_300chars ||
          lead.pitch_text ||
          `Hi ${lead.recruiter_name}, reaching out regarding ${lead.target_role} roles at ${lead.company}.`;
        const lPitch = el('p', 'career-lead-pitch', noteText);

        const lFollowup = el('div', 'career-lead-followup');
        if (lead.day_3_followup_date) {
          lFollowup.append(el('span', 'career-followup-pill', `Day-3 Follow-Up Due: ${lead.day_3_followup_date}`));
        }
        if (lead.day_7_followup_date) {
          lFollowup.append(el('span', 'career-followup-pill', `Day-7 Follow-Up Due: ${lead.day_7_followup_date}`));
        }

        lMain.append(lTitleRow, lPitch, lFollowup);

        const lActions = el('div', 'career-lead-actions');
        const copyBtn = el('button', 'career-btn career-btn-secondary career-btn-sm', 'Copy Note');
        copyBtn.type = 'button';
        copyBtn.addEventListener('click', () => {
          void (navigator.clipboard?.writeText(noteText) ?? Promise.reject(new Error("Clipboard API unavailable")))
            .then(() => this.notify(`Copied 300-char connection note for ${lead.recruiter_name}`))
            .catch(() => this.notify('Copy failed — clipboard unavailable in this browser context.', true));
        });

        const statusSelect = el('select', 'career-select-sm');
        const statuses = [
          'DRAFT_PENDING_MANUAL_SEND',
          'SENT',
          'CONNECTED',
          'PITCH_SENT',
          'CALL_SCHEDULED',
          'REJECTED',
        ];
        for (const st of statuses) {
          const opt = el('option', '', st);
          opt.value = st;
          if (lead.status === st) opt.selected = true;
          statusSelect.append(opt);
        }
        statusSelect.addEventListener('change', () => {
          void this.updateLeadStatus(lead.lead_id, statusSelect.value);
        });

        lActions.append(copyBtn, statusSelect);
        lCard.append(lMain, lActions);
        leadsList.append(lCard);
      }
      crmSection.append(leadsList);
    }

    wrapper.append(crmSection);
    return wrapper;
  }

  private buildDiagnosticFixButton(alert: BottleneckAlert): HTMLButtonElement {
    const btn = el('button', 'career-btn career-btn-primary career-btn-sm');
    btn.type = 'button';
    btn.disabled = this.actionInProgress;

    switch (alert.code) {
      case 'LOW_SEARCH_APPEARANCES':
        btn.textContent = 'Fix Now: Resdex Bump';
        btn.addEventListener('click', () => void this.triggerBump());
        break;
      case 'LOW_CONTACT_VIEWS':
        btn.textContent = 'Fix Now: Optimize Headline SEO';
        btn.addEventListener('click', () => this.setTab('boost'));
        break;
      case 'LOW_APPLICATION_VELOCITY':
        btn.textContent = 'Fix Now: Run Block 1 Apply Batch';
        btn.addEventListener('click', () => void this.executeBlock(1));
        break;
      case 'LOW_OUTREACH_VOLUME':
      case 'LOW_REPLY_RATE':
        btn.textContent = 'Fix Now: Run Block 2 Outbound Pitches';
        btn.addEventListener('click', () => void this.executeBlock(2));
        break;
      case 'LOW_CALL_CONVERSION':
      default:
        btn.textContent = 'Fix Now: Run Block 3 Follow-Up Sweep';
        btn.addEventListener('click', () => void this.executeBlock(3));
        break;
    }
    return btn;
  }

  // ============================================================================
  // TAB 2: DAILY PLANNER (3 Routine Blocks + Study Sprints)
  // ============================================================================
  private renderPlanTab(): HTMLElement {
    const wrapper = el('div', 'career-plan-grid');

    const introCard = el('div', 'career-card career-plan-intro');
    introCard.append(
      el('h3', 'career-card-title', '3-Block Daily Career & Study Rhythm'),
      el(
        'p',
        'career-muted',
        `Synchronizes your ${this.readiness?.profile?.target_role || 'engineering'} job applications, Resdex freshness bumps, and 45-minute CourseForge Pomodoro masterclass sprints.`,
      ),
    );
    wrapper.append(introCard);

    const blocks = this.planToday?.blocks || [
      {
        block_id: 1 as const,
        title: 'BLOCK 1: Morning Routine (09:00 - 11:30 IST)',
        time_window: '09:00 - 11:30 IST',
        tasks: [
          "[Career] Resdex Profile Bump to 'Active Today'",
          `[Career] High-Velocity Apply: 20-25 ${this.readiness?.profile?.target_role || 'Software Engineer'} Vacancies`,
          '[Study]  45-Min CourseForge Masterclass Sprint',
        ],
        status: 'pending' as const,
        is_active: false,
      },
      {
        block_id: 2 as const,
        title: 'BLOCK 2: Afternoon Outbound (14:00 - 16:30 IST)',
        time_window: '14:00 - 16:30 IST',
        tasks: [
          `[Career] Top GCC Recruiter Outbound: 10 Custom ${this.readiness?.profile?.target_role || 'Software Engineer'} Pitches`,
          '[Career] Post-Lunch Resdex Bump',
          '[Study]  45-Min Hands-on Code Lab Sprint',
        ],
        status: 'pending' as const,
        is_active: false,
      },
      {
        block_id: 3 as const,
        title: 'BLOCK 3: Evening Sweep & Review (18:30 - 20:30 IST)',
        time_window: '18:30 - 20:30 IST',
        tasks: [
          '[Career] Evening Resdex Bump (Sweep US recruiter & after-hours shift)',
          '[Career] 48-Hour Follow-Up Batch (5 high-urgency candidate follow-ups)',
          '[Study]  AI Tutor Mock Interview: 3 Technical Scenarios',
        ],
        status: 'pending' as const,
        is_active: false,
      },
    ];

    const blocksContainer = el('div', 'career-blocks-list');
    for (const b of blocks) {
      const bCard = el('div', `career-card career-block-card ${b.is_active ? 'active-window' : ''}`);
      const bHead = el('div', 'career-block-head');
      const bTitleWrap = el('div', '');
      bTitleWrap.append(
        el('span', 'career-block-time', b.time_window),
        el('h4', 'career-block-title', b.title),
      );

      const execBtn = el('button', 'career-btn career-btn-primary');
      execBtn.type = 'button';
      execBtn.disabled = this.actionInProgress;
      execBtn.textContent = `Execute Block ${b.block_id}`;
      execBtn.addEventListener('click', () => void this.executeBlock(b.block_id as 1 | 2 | 3));

      bHead.append(bTitleWrap, execBtn);
      bCard.append(bHead);

      const taskList = el('ul', 'career-task-list');
      for (const t of b.tasks) {
        const key = `${b.block_id}:${t}`;
        const li = el('li', `career-task-item ${this.checkedTasks.has(key) ? 'checked' : ''}`);
        const cb = el('input', 'career-task-cb');
        cb.type = 'checkbox';
        cb.checked = this.checkedTasks.has(key);
        cb.addEventListener('change', () => {
          if (cb.checked) {
            this.checkedTasks.add(key);
          } else {
            this.checkedTasks.delete(key);
          }
          this.saveCheckedTasks();
          this.render();
        });
        const label = el('span', 'career-task-text', t);
        li.append(cb, label);

        if (t.includes('[Study]') && this.options.onNavigatePlan) {
          const studyBtn = el('button', 'career-btn career-btn-secondary career-btn-sm', 'Open Study Sprint');
          studyBtn.type = 'button';
          studyBtn.addEventListener('click', () => this.options.onNavigatePlan?.());
          li.append(studyBtn);
        }
        taskList.append(li);
      }

      bCard.append(taskList);
      blocksContainer.append(bCard);
    }

    wrapper.append(blocksContainer);
    return wrapper;
  }

  // ============================================================================
  // TAB 3: PROFILE BOOST & SEO (Resdex Bump + Bandit Policy + Keyword Utility)
  // ============================================================================
  private renderBoostTab(): HTMLElement {
    const wrapper = el('div', 'career-boost-grid');

    const topRow = el('div', 'career-boost-top-row');

    const freshnessCard = el('div', 'career-card');
    const freshness = this.boostStatus?.active_today ? 'Active Today' : 'Ready for Bump';
    const cooldown = this.boostStatus?.cooldown_remaining_seconds ?? 0;
    freshnessCard.append(
      el('span', 'career-badge-pill', 'NAUKRI RESDEX FRESHNESS'),
      el('h3', 'career-boost-status-title', freshness),
      el(
        'p',
        'career-muted',
        cooldown > 0
          ? `Cooldown active: next bump recommended in ${Math.ceil(cooldown / 60)} min.`
          : 'Profile is eligible for an immediate Resdex freshness touch.',
      ),
    );
    const triggerBtn = el('button', 'career-btn career-btn-primary', 'Trigger Resdex Bump Now');
    triggerBtn.type = 'button';
    triggerBtn.disabled = this.actionInProgress;
    triggerBtn.addEventListener('click', () => void this.triggerBump());
    freshnessCard.append(triggerBtn);

    const policyCard = el('div', 'career-card');
    policyCard.append(
      el('span', 'career-badge-pill', 'CONTEXTUAL BANDIT ENGINE'),
      el('h3', 'career-boost-status-title', `LinUCB Selection Policy (${this.boostStatus?.policy_version || 'v2.1-linucb'})`),
      el(
        'p',
        'career-muted',
        `Mode: ${this.boostStatus?.policy_mode || 'ACTIVE'} · Decisions Recorded: ${this.boostStatus?.policy_decisions_count ?? 0}`,
      ),
      el(
        'p',
        'career-muted',
        `Strict ground-truth guardrails active: ${this.readiness?.profile?.total_yoe ?? 2.0} YOE, ${this.readiness?.profile?.notice_period_days ?? 30}-day notice, and whitelisted ${this.readiness?.profile?.target_role || 'role'} tokens.`,
      ),
    );

    topRow.append(freshnessCard, policyCard);
    wrapper.append(topRow);

    // Keyword Utility Table
    const kwCard = el('div', 'career-card');
    kwCard.append(
      el('h3', 'career-card-title', 'Market Keyword Utility & Headline SEO Scores'),
      el('p', 'career-muted', 'Ranked by Recruiter Demand Frequency ÷ Candidate Saturation. Click Inject to add to your headline whitelist.'),
    );

    const kwTable = el('table', 'career-table');
    kwTable.innerHTML = `
      <thead>
        <tr>
          <th>Keyword Token</th>
          <th>Market Demand</th>
          <th>Saturation</th>
          <th>Utility Score</th>
          <th>Status / Action</th>
        </tr>
      </thead>
    `;
    const kwBody = el('tbody', '');
    for (const kw of this.boostStatus?.keyword_utilities || []) {
      const tr = el('tr', '');
      const tokenTd = el('td', '');
      tokenTd.append(el('strong', '', kw.token));
      const utilityTd = el('td', '');
      utilityTd.append(el('span', 'career-utility-pill', kw.utility_score.toFixed(2)));
      tr.append(tokenTd, el('td', '', String(kw.demand_frequency)), el('td', '', String(kw.saturation_count)), utilityTd);
      const actionTd = el('td', '');
      if (kw.claimable) {
        const injectBtn = el('button', 'career-btn career-btn-secondary career-btn-sm', 'Inject into Headline');
        injectBtn.type = 'button';
        injectBtn.disabled = this.actionInProgress;
        injectBtn.addEventListener('click', () => {
          const prof = this.readiness?.profile;
          if (prof) {
            const nextSkills = prof.primary_skills.includes(kw.token)
              ? prof.primary_skills
              : [kw.token, ...prof.primary_skills];
            void this.saveProfileOverrides({
              ...prof,
              primary_skills: nextSkills,
            });
          } else {
            this.notify(`Injected "${kw.token}" into active headline whitelist.`);
          }
        });
        actionTd.append(injectBtn);
      } else {
        actionTd.append(el('span', 'career-claim-tag blocked', 'Quarantined'));
      }
      tr.append(actionTd);
      kwBody.append(tr);
    }
    kwTable.append(kwBody);
    kwCard.append(kwTable);
    wrapper.append(kwCard);

    // Mutation Audit Trail
    const mutCard = el('div', 'career-card');
    mutCard.append(
      el('h3', 'career-card-title', 'Profile Mutation Provenance & SHA-256 Audit Trail'),
      el('p', 'career-muted', 'Every automated profile touch or headline update is hashed for rollback safety.'),
    );

    const mutations = this.boostStatus?.recent_mutations || [];
    if (mutations.length === 0) {
      mutCard.append(el('p', 'career-empty-state', 'No mutations logged for your account yet. Trigger a Resdex bump above to record your first audit entry.'));
    } else {
      const mutList = el('div', 'career-mutations-list');
      for (const m of mutations.slice(0, 8)) {
        const row = el('div', 'career-mutation-row');
        row.append(
          el('strong', '', `${m.platform.toUpperCase()} · ${m.field}`),
          el('span', 'career-muted', m.rationale || m.mutation_type),
          el('code', 'career-hash-code', `SHA256: ${(m.new_hash || '').slice(0, 8)}…`),
          el('span', 'career-status-badge status-APPLIED', m.status),
        );
        mutList.append(row);
      }
      mutCard.append(mutList);
    }
    wrapper.append(mutCard);

    return wrapper;
  }

  // ============================================================================
  // TAB 4: APPLICATION LEDGER & CSV EXPORT
  // ============================================================================
  private renderLedgerTab(): HTMLElement {
    const wrapper = el('div', 'career-ledger-grid');

    const headCard = el('div', 'career-card career-ledger-head');
    const leftInfo = el('div', '');
    leftInfo.append(
      el('h3', 'career-card-title', `Application Ledger (${this.jobsTotal} Total Records)`),
      el('p', 'career-muted', 'Complete per-user audit trail of automated and 1-click applications with match scores.'),
    );

    const rightControls = el('div', 'career-ledger-controls');
    const searchInput = el('input', 'career-input career-ledger-search');
    searchInput.type = 'search';
    searchInput.placeholder = 'Filter by company or role...';
    searchInput.value = this.ledgerSearch;
    searchInput.addEventListener('input', () => {
      this.ledgerSearch = searchInput.value;
      const caret = searchInput.selectionStart;
      this.render();
      // render() rebuilds the DOM; restore focus/caret so typing is not interrupted.
      const next = this.options.root.querySelector<HTMLInputElement>('.career-ledger-search');
      if (next) {
        next.focus();
        if (caret !== null) next.setSelectionRange(caret, caret);
      }
    });

    const platformSelect = el('select', 'career-select-sm');
    for (const [val, label] of [
      ['', 'All Platforms'],
      ['naukri', 'Naukri'],
      ['linkedin', 'LinkedIn'],
      ['instahyre', 'Instahyre'],
    ] as const) {
      const opt = el('option', '', label);
      opt.value = val;
      if (this.ledgerPlatformFilter === val) opt.selected = true;
      platformSelect.append(opt);
    }
    platformSelect.addEventListener('change', () => {
      this.ledgerPlatformFilter = platformSelect.value;
      this.render();
    });

    const exportLink = el('a', 'career-btn career-btn-secondary', 'Download CSV Export');
    exportLink.href = '/api/v1/career/export.csv';
    exportLink.setAttribute('download', 'courseforge_career_applied_jobs.csv');

    rightControls.append(searchInput, platformSelect, exportLink);
    headCard.append(leftInfo, rightControls);
    wrapper.append(headCard);

    const filteredJobs = this.jobs.filter(j => {
      if (this.ledgerPlatformFilter && j.platform.toLowerCase() !== this.ledgerPlatformFilter.toLowerCase()) {
        return false;
      }
      if (this.ledgerSearch.trim()) {
        const q = this.ledgerSearch.trim().toLowerCase();
        return (
          j.company.toLowerCase().includes(q) ||
          j.title.toLowerCase().includes(q) ||
          (j.location || '').toLowerCase().includes(q)
        );
      }
      return true;
    });

    const tableCard = el('div', 'career-card career-table-wrap');
    if (filteredJobs.length === 0) {
      tableCard.append(
        el(
          'p',
          'career-empty-state',
          this.jobs.length === 0
            ? 'No applications recorded in your personal ledger yet. Execute Block 1 in the Daily Plan tab or use the Outcome Tracker tab to log applications.'
            : 'No applications match your current search filter.',
        ),
      );
    } else {
      const table = el('table', 'career-table');
      table.innerHTML = `
        <thead>
          <tr>
            <th>Platform</th>
            <th>Company</th>
            <th>Role Title</th>
            <th>Location</th>
            <th>Match Score</th>
            <th>Status</th>
            <th>Applied At</th>
          </tr>
        </thead>
      `;
      const tbody = el('tbody', '');
      for (const j of filteredJobs) {
        const tr = el('tr', '');
        const dateStr = j.applied_at ? new Date(j.applied_at).toLocaleDateString() : '—';
        const platformTd = el('td', '');
        platformTd.append(el('span', 'career-platform-tag', j.platform));
        const companyTd = el('td', '');
        companyTd.append(el('strong', '', j.company));
        const scoreTd = el('td', '');
        scoreTd.append(el('span', 'career-score-pill', `${Number(j.match_score || 70).toFixed(0)}%`));
        const statusTd = el('td', '');
        statusTd.append(el('span', `career-status-badge status-${j.status}`, j.status));
        tr.append(
          platformTd,
          companyTd,
          el('td', '', j.title),
          el('td', '', j.location || 'Bengaluru'),
          scoreTd,
          statusTd,
          el('td', 'career-muted', dateStr),
        );
        tbody.append(tr);
      }
      table.append(tbody);
      tableCard.append(table);
    }

    wrapper.append(tableCard);
    return wrapper;
  }
}
