import { svgIcon } from '../icons';
import { ApiClient, errorMessage } from '../api';
import './style.css';
import type {
  BoostStatus,
  DailyPacing,
  PlanTodayResponse,
  RecruiterLead,
  AppliedJob,
  BottleneckAlert,
  CandidateProfile,
  PlatformAuthRequirement,
  EngineReadiness,
} from './contracts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export interface CareerViewOptions {
  root: HTMLElement;
  api: ApiClient;
  feedback?: (message: string, error?: boolean) => void;
  onNavigatePlan?: () => void;
}

export class CareerView {
  private activeTab: 'goal' | 'plan' | 'boost' | 'ledger' = 'goal';
  private loading = false;
  private actionInProgress = false;
  private bannerMessage: string | null = null;
  private checkedTasks = new Set<string>();
  private abortController: AbortController | null = null;

  // Cached Domain State
  private boostStatus: BoostStatus | null = null;
  private pacing: DailyPacing | null = null;
  private planToday: PlanTodayResponse | null = null;
  private leads: RecruiterLead[] = [];
  private jobs: AppliedJob[] = [];
  private jobsTotal = 0;
  private readiness: EngineReadiness | null = null;
  private setupPanelOpen = false;
  private resumePasteDraft = '';

  constructor(private readonly options: CareerViewOptions) {}

  activate(_signal?: AbortSignal): void {
    this.options.root.hidden = false;
    void this.init();
  }

  async init(): Promise<void> {
    this.abortController?.abort();
    this.abortController = new AbortController();
    await this.refreshAll();
  }

  deactivate(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.actionInProgress = false;
    this.bannerMessage = null;
    this.options.root.hidden = true;
    this.options.root.innerHTML = '';
  }

  setTab(tab: 'goal' | 'plan' | 'boost' | 'ledger'): void {
    this.activeTab = tab;
    this.render();
  }

  async refreshAll(): Promise<void> {
    this.loading = true;
    this.render();

    try {
      const [boostRes, pacingRes, planRes, leadsRes, jobsRes, readinessRes] = await Promise.allSettled([
        this.options.api.request<BoostStatus>('/career/boost/status'),
        this.options.api.request<DailyPacing>('/career/goal/pacing'),
        this.options.api.request<PlanTodayResponse>('/career/plan/today'),
        this.options.api.request<{ leads: RecruiterLead[] }>('/career/goal/leads'),
        this.options.api.request<{ jobs: AppliedJob[]; total: number }>('/career/jobs?limit=50'),
        this.options.api.request<EngineReadiness>('/career/engine/readiness'),
      ]);

      if (boostRes.status === 'fulfilled') this.boostStatus = boostRes.value;
      if (pacingRes.status === 'fulfilled') this.pacing = pacingRes.value;
      if (planRes.status === 'fulfilled') this.planToday = planRes.value;
      if (leadsRes.status === 'fulfilled') this.leads = leadsRes.value.leads || [];
      if (jobsRes.status === 'fulfilled') {
        this.jobs = jobsRes.value.jobs || [];
        this.jobsTotal = jobsRes.value.total || 0;
      }
      if (readinessRes.status === 'fulfilled') this.readiness = readinessRes.value;
    } catch (e) {
      console.error('Error fetching career data', e);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async triggerBump(): Promise<void> {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    this.bannerMessage = 'Executing Resdex Profile Bump…';
    this.render();

    try {
      const res = await this.options.api.request<{ success: boolean; message: string }>('/career/boost/bump', {
        method: 'POST',
        body: { dry_run: false },
      });
      this.bannerMessage = res.message || 'Resdex profile bump successfully completed.';
      await this.refreshAll();
    } catch (err) {
      this.bannerMessage = `Bump execution notice: ${errorMessage(err)}`;
      this.render();
    } finally {
      this.actionInProgress = false;
    }
  }

  private async executeBlock(blockId: number): Promise<void> {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    this.bannerMessage = `Executing Block ${blockId} routine…`;
    this.render();

    try {
      const res = await this.options.api.request<{ message: string; tasks_completed: string[] }>('/career/plan/execute-block', {
        method: 'POST',
        body: { block: blockId, dry_run: false },
      });
      this.bannerMessage = res.message || `Block ${blockId} executed successfully!`;
      await this.refreshAll();
    } catch (err) {
      this.bannerMessage = `Block execution error: ${errorMessage(err)}`;
      this.render();
    } finally {
      this.actionInProgress = false;
    }
  }

  private async updateLeadStatus(leadId: string, status: string): Promise<void> {
    try {
      await this.options.api.request(`/career/goal/leads/${leadId}/status`, {
        method: 'PUT',
        body: { status },
      });
      this.bannerMessage = `Updated recruiter lead status to: ${status}`;
      await this.refreshAll();
    } catch (err) {
      this.bannerMessage = `Failed to update lead: ${errorMessage(err)}`;
      this.render();
    }
  }

  private async createLead(lead: Partial<RecruiterLead>): Promise<void> {
    try {
      await this.options.api.request('/career/goal/leads', {
        method: 'POST',
        body: lead,
      });
      this.bannerMessage = `Added recruiter lead for ${lead.recruiter_name} at ${lead.company}`;
      await this.refreshAll();
    } catch (err) {
      this.bannerMessage = `Failed to save lead: ${errorMessage(err)}`;
      this.render();
    }
  }

  render(): void {
    const root = this.options.root;
    root.innerHTML = '';

    const container = el('div', 'career-studio-view');

    // 1. Header Area
    const prof = this.readiness?.profile;
    const eng = this.readiness?.engine;
    const roleLabel = prof?.target_role || 'AZURE DATA ENGINEER';
    const ctcLabel = prof?.target_ctc_range || '₹25 LPA';
    const yoeLabel = prof ? `${prof.total_yoe} YOE` : '2.5 YOE';
    const engineRunning = eng?.engine_status === 'RUNNING';

    const header = el('div', 'career-header');
    const titleArea = el('div', 'career-title-area');
    const h2 = el('h2', '', 'CourseForge Career Studio');
    const badge = el(
      'span',
      'career-engine-badge',
      `UNIVERSAL AI CAREER ENGINE · ROLE: ${roleLabel.toUpperCase()} (${yoeLabel}) · TARGET: ${ctcLabel} · 5-CALLS/DAY PACING`
    );
    titleArea.append(h2, badge);

    const topActions = el('div', 'career-top-actions');

    const setupToggleBtn = el(
      'button',
      `button ${this.setupPanelOpen ? 'primary' : 'quiet'}`,
      this.setupPanelOpen ? '✓ Close Setup & Auth' : '⚙️ Upload Resume & Auth Setup'
    );
    setupToggleBtn.type = 'button';
    setupToggleBtn.addEventListener('click', () => {
      this.setupPanelOpen = !this.setupPanelOpen;
      this.render();
    });

    const startEngineBtn = el(
      'button',
      `button ${engineRunning ? 'quiet' : 'primary'}`,
      engineRunning ? '⏸ Pause Process' : '🚀 Start Career Process'
    );
    startEngineBtn.type = 'button';
    startEngineBtn.disabled = this.actionInProgress;
    startEngineBtn.addEventListener('click', () => {
      if (engineRunning) {
        void this.pauseEngine();
      } else {
        void this.startEngine(eng?.execution_mode || 'DRY_RUN');
      }
    });

    const bumpBtn = el('button', 'button primary', this.actionInProgress ? 'Executing…' : 'Run Resdex Bump Now');
    bumpBtn.type = 'button';
    bumpBtn.disabled = this.actionInProgress;
    bumpBtn.addEventListener('click', () => { void this.triggerBump(); });

    const exportBtn = el('a', 'button quiet', 'Export Tracker CSV');
    exportBtn.setAttribute('href', '/api/v1/career/export.csv');
    exportBtn.setAttribute('download', 'courseforge_career_applied_jobs.csv');

    topActions.append(setupToggleBtn, startEngineBtn, bumpBtn, exportBtn);
    header.append(titleArea, topActions);
    container.append(header);

    // 1b. Universal Profile & Pre-Flight Readiness Summary Strip
    container.append(this.renderReadinessStrip());

    // 1c. Collapsible Universal Setup Studio (Resume Upload -> Platform Auth -> Launch)
    if (this.setupPanelOpen) {
      container.append(this.renderSetupStudio());
    }

    // 2. Banner Toast (if active)
    if (this.bannerMessage) {
      const toast = el('div', 'career-banner-toast');
      toast.append(el('span', '', this.bannerMessage));
      const dismiss = el('button', 'button quiet', '✕');
      dismiss.addEventListener('click', () => {
        this.bannerMessage = null;
        this.render();
      });
      toast.append(dismiss);
      container.append(toast);
    }

    // 3. Navigation Tabs Bar
    const tabsBar = el('div', 'career-tabs-bar');
    const tabs: Array<{ id: 'goal' | 'plan' | 'boost' | 'ledger'; label: string; icon: string }> = [
      { id: 'goal', label: 'Goal & Pacing (5 Calls)', icon: 'target' },
      { id: 'plan', label: 'Daily Sprints (3 Blocks)', icon: 'calendar' },
      { id: 'boost', label: 'Profile SEO & Boost', icon: 'zap' },
      { id: 'ledger', label: `Application Ledger (${this.jobsTotal})`, icon: 'file' },
    ];

    for (const t of tabs) {
      const tabBtn = el('button', `career-tab-btn ${this.activeTab === t.id ? 'active' : ''}`);
      tabBtn.type = 'button';
      tabBtn.append(svgIcon(t.icon as any), el('span', '', t.label));
      tabBtn.addEventListener('click', () => {
        this.activeTab = t.id;
        this.render();
      });
      tabsBar.append(tabBtn);
    }
    container.append(tabsBar);

    // 4. Tab Content Area
    if (this.loading && !this.pacing && !this.boostStatus) {
      const loader = el('div', 'muted', 'Synchronizing live career metrics and bandit state…');
      container.append(loader);
    } else {
      switch (this.activeTab) {
        case 'goal':
          container.append(this.renderGoalView());
          break;
        case 'plan':
          container.append(this.renderPlanView());
          break;
        case 'boost':
          container.append(this.renderBoostView());
          break;
        case 'ledger':
          container.append(this.renderLedgerView());
          break;
      }
    }

    root.append(container);
  }

  // ----------------- Sub-View 1: Goal & Pacing -----------------
  private renderGoalView(): HTMLElement {
    const wrapper = el('div', 'career-goal-wrapper');

    // Quotas row
    const quotasGrid = el('div', 'quota-stats-grid');
    const calls = this.pacing?.calls_scheduled_count || 0;
    const apps = this.pacing?.applications_count || 0;
    const outreach = this.pacing?.outreaches_count || 0;
    const appearances = this.pacing?.search_appearances || 0;

    const stats = [
      { label: 'Scheduled Calls Today', current: calls, target: '/ 5.0 target', color: '#38bdf8' },
      { label: 'Applications Sent', current: apps, target: '/ 35 target', color: '#34d399' },
      { label: 'Recruiter Outbounds', current: outreach, target: '/ 15 target', color: '#a78bfa' },
      { label: 'Resdex Appearances', current: appearances, target: '/ 150 weekly', color: '#f59e0b' },
    ];

    for (const s of stats) {
      const c = el('div', 'quota-stat-card');
      c.append(el('h4', '', s.label));
      const valRow = el('div', 'quota-val-row');
      valRow.append(
        el('span', 'quota-current', String(s.current)),
        el('span', 'quota-target', s.target),
      );
      c.append(valRow);
      quotasGrid.append(c);
    }
    wrapper.append(quotasGrid);

    // Goal Grid (Radial Gauge + Bottlenecks)
    const goalGrid = el('div', 'career-goal-grid');

    // Radial Pacing Gauge
    const radialCard = el('div', 'career-radial-card');
    radialCard.append(el('h3', '', 'North Star Call Pacing'));
    radialCard.append(el('p', 'muted', 'Daily velocity toward 5 screening calls'));

    const gaugeBox = el('div', 'radial-gauge-container');
    const radius = 65;
    const circumference = 2 * Math.PI * radius; // ~408.4
    const ratio = Math.min(1.0, calls / 5.0);
    const offset = circumference * (1 - ratio);

    gaugeBox.innerHTML = `
      <svg class="radial-gauge-svg" viewBox="0 0 160 160">
        <circle class="gauge-track" cx="80" cy="80" r="${radius}"></circle>
        <circle class="gauge-fill" cx="80" cy="80" r="${radius}"
          stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"></circle>
      </svg>
      <div class="radial-gauge-content">
        <span class="gauge-number">${calls}</span>
        <span class="gauge-label">of 5 calls</span>
      </div>
    `;

    const ratioPct = Math.round(ratio * 100);
    const ratioText = el('p', 'muted', `Pacing at ${ratioPct}% of daily North Star target.`);
    radialCard.append(gaugeBox, ratioText);
    goalGrid.append(radialCard);

    // Bottlenecks list
    const bottlenecksCol = el('div', 'bottlenecks-col');
    bottlenecksCol.append(el('h3', '', 'Active Bottleneck Diagnostics (6-Stage Engine)'));

    const alerts = this.pacing?.active_bottlenecks || [];
    if (alerts.length === 0) {
      bottlenecksCol.append(el('p', 'muted', 'All funnel stages operating at target run-rate! Zero bottlenecks detected.'));
    } else {
      const list = el('div', 'bottlenecks-list');
      for (const alert of alerts) {
        const bCard = el('div', `bottleneck-card severity-${alert.severity}`);
        const left = el('div', 'bottleneck-left');
        left.append(
          el('span', 'bottleneck-stage', `${alert.stage} · ${alert.severity}`),
          el('span', 'bottleneck-desc', alert.description),
          el('span', 'bottleneck-action', `Action: ${alert.action_required}`),
        );
        const actionBtn = el('button', 'button outline', 'Remediate');
        actionBtn.type = 'button';
        actionBtn.addEventListener('click', () => {
          if (alert.code.includes('APPEARANCES') || alert.code.includes('CONTACT')) {
            void this.triggerBump();
          } else {
            void this.executeBlock(1);
          }
        });
        bCard.append(left, actionBtn);
        list.append(bCard);
      }
      bottlenecksCol.append(list);
    }
    goalGrid.append(bottlenecksCol);
    wrapper.append(goalGrid);

    // Recruiter CRM Leads Table
    const crmSection = el('div', 'career-crm-section');
    crmSection.style.marginTop = '2rem';
    
    const crmHeaderRow = el('div', 'career-section-header-row');
    crmHeaderRow.append(el('h3', '', 'Recruiter CRM Pipeline & Follow-Ups'));

    const addLeadBtn = el('button', 'button quiet', '+ Quick Add Lead');
    addLeadBtn.type = 'button';
    addLeadBtn.addEventListener('click', () => {
      const name = prompt('Recruiter Name:');
      if (!name) return;
      const comp = prompt('Company Name:') || 'Target Company';
      void this.createLead({
        recruiter_name: name,
        company: comp,
        target_role: 'Azure Data Engineer',
        status: 'DRAFT_PENDING_MANUAL_SEND',
        message_type: 'Direct InMail',
        pitch_text: `Reaching out regarding Azure Data Engineer opportunities at ${comp}.`,
        connection_note_300chars: `Hi ${name}, saw your Azure Data Engineering opening at ${comp}. 2.5 YOE with Databricks & PySpark Medallion Lakehouses, 15-day notice, ₹20-25 LPA target. Best, Lavkush`
      });
    });
    crmHeaderRow.append(addLeadBtn);
    crmSection.append(crmHeaderRow);

    if (this.leads.length === 0) {
      crmSection.append(el('p', 'muted', 'No recruiter contacts in CRM. Dispatched InMails and pitches will appear here.'));
    } else {
      const tableWrapper = el('div', 'career-table-wrapper');
      const table = el('table', 'career-table');
      table.innerHTML = `
        <thead>
          <tr>
            <th>Recruiter</th>
            <th>Company</th>
            <th>Role</th>
            <th>Status</th>
            <th>Follow-Up Due</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody></tbody>
      `;
      const tbody = table.querySelector('tbody')!;
      for (const lead of this.leads) {
        const tr = document.createElement('tr');
        const isScheduled = lead.status === 'CALL_SCHEDULED';

        tr.innerHTML = `
          <td><strong>${lead.recruiter_name}</strong></td>
          <td>${lead.company}</td>
          <td>${lead.target_role}</td>
          <td><span class="lead-status-pill status-${lead.status}">${lead.status}</span></td>
          <td>${lead.day_3_followup_date || 'N/A'}</td>
          <td></td>
        `;

        const actionsTd = tr.querySelector('td:last-child')!;
        if (!isScheduled) {
          const callBtn = el('button', 'button quiet', 'Schedule Call');
          callBtn.type = 'button';
          callBtn.addEventListener('click', () => { void this.updateLeadStatus(lead.lead_id, 'CALL_SCHEDULED'); });
          actionsTd.append(callBtn);
        }

        if (lead.connection_note_300chars) {
          const copyBtn = el('button', 'button quiet', 'Copy Note');
          copyBtn.type = 'button';
          copyBtn.addEventListener('click', () => {
            void navigator.clipboard.writeText(lead.connection_note_300chars);
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy Note'; }, 1500);
          });
          actionsTd.append(copyBtn);
        }

        tbody.append(tr);
      }
      tableWrapper.append(table);
      crmSection.append(tableWrapper);
    }

    wrapper.append(crmSection);
    return wrapper;
  }

  // ----------------- Sub-View 2: Daily Plan & Sprints -----------------
  private renderPlanView(): HTMLElement {
    const wrapper = el('div', 'career-plan-wrapper');
    wrapper.append(el('h3', '', 'Unified Daily Schedule: 3 Career & Study Blocks (IST)'));

    const blocksGrid = el('div', 'plan-blocks-grid');
    const blocks = this.planToday?.blocks || [];

    for (const b of blocks) {
      const card = el('div', `plan-block-card ${b.is_active ? 'active-block' : ''}`);
      const header = el('div', 'plan-block-header');
      header.append(
        el('h4', 'plan-block-title', b.title),
        el('span', 'plan-block-time', b.time_window),
      );
      card.append(header);

      const taskList = el('ul', 'plan-tasks-list');
      for (let i = 0; i < b.tasks.length; i++) {
        const t = b.tasks[i];
        const taskKey = `block_${b.block_id}_task_${i}`;
        const isDone = this.checkedTasks.has(taskKey);

        const item = el('li', `plan-task-item ${isDone ? 'task-done' : ''}`);
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = isDone;
        checkbox.className = 'career-task-checkbox';
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) {
            this.checkedTasks.add(taskKey);
          } else {
            this.checkedTasks.delete(taskKey);
          }
          item.classList.toggle('task-done', checkbox.checked);
        });

        const span = el('span', '', t);
        item.append(checkbox, span);
        taskList.append(item);
      }
      card.append(taskList);

      const btnGroup = el('div', 'plan-block-actions');
      const execBtn = el('button', 'button primary', `Execute Block ${b.block_id}`);
      execBtn.type = 'button';
      execBtn.disabled = this.actionInProgress;
      execBtn.addEventListener('click', () => { void this.executeBlock(b.block_id); });

      const pomodoroBtn = el('button', 'button outline', 'Start Focus Sprint (45m)');
      pomodoroBtn.type = 'button';
      pomodoroBtn.addEventListener('click', () => {
        if (this.options.onNavigatePlan) {
          this.options.onNavigatePlan();
        } else {
          this.bannerMessage = `Focused Pomodoro block ${b.block_id} routine initiated.`;
          this.render();
        }
      });

      btnGroup.append(execBtn, pomodoroBtn);
      card.append(btnGroup);
      blocksGrid.append(card);
    }

    wrapper.append(blocksGrid);
    return wrapper;
  }

  // ----------------- Sub-View 3: Profile SEO & Boost -----------------
  private renderBoostView(): HTMLElement {
    const wrapper = el('div', 'career-boost-wrapper');

    const topGrid = el('div', 'quota-stats-grid');
    const activeToday = this.boostStatus?.active_today;
    const cooldown = this.boostStatus?.cooldown_remaining_seconds || 0;
    const cooldownMin = Math.ceil(cooldown / 60);

    const boostCard = el('div', 'quota-stat-card');
    boostCard.append(el('h4', '', 'Naukri Resdex Freshness'));
    const bumpRow = el('div', 'quota-val-row');
    bumpRow.append(
      el('span', 'quota-current', activeToday ? 'Active Today' : 'Touch Pending'),
      el('span', 'quota-target', cooldown > 0 ? `(${cooldownMin}m cooldown)` : '(Ready)'),
    );
    boostCard.append(bumpRow);

    const banditCard = el('div', 'quota-stat-card');
    banditCard.append(el('h4', '', 'LinUCB Selection Policy'));
    const banditRow = el('div', 'quota-val-row');
    banditRow.append(
      el('span', 'quota-current', this.boostStatus?.policy_mode || 'ACTIVE'),
      el('span', 'quota-target', `${this.boostStatus?.policy_decisions_count || 0} decisions`),
    );
    banditCard.append(banditRow);

    topGrid.append(boostCard, banditCard);
    wrapper.append(topGrid);

    // Keyword Utility Table
    wrapper.append(el('h3', '', 'Keyword Utility Mining (High-Demand Tokens)'));
    const kwTableWrapper = el('div', 'career-table-wrapper');
    const kwTable = el('table', 'career-table');
    kwTable.innerHTML = `
      <thead>
        <tr>
          <th>Token / Competency</th>
          <th>Demand Frequency</th>
          <th>Saturation Count</th>
          <th>Utility Score (U)</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const kwTbody = kwTable.querySelector('tbody')!;
    const keywords = this.boostStatus?.keyword_utilities || [];

    for (const kw of keywords) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${kw.token}</strong></td>
        <td>${kw.demand_frequency}</td>
        <td>${kw.saturation_count}</td>
        <td><span class="badge-stat">${kw.utility_score.toFixed(1)}</span></td>
        <td><button class="button quiet inject-kw-btn">Inject to Headline</button></td>
      `;
      const btn = tr.querySelector('.inject-kw-btn')!;
      btn.addEventListener('click', () => {
        btn.textContent = 'Injected!';
        this.bannerMessage = `Token '${kw.token}' injected into candidate mutation whitelist.`;
        setTimeout(() => { btn.textContent = 'Inject to Headline'; }, 1500);
      });
      kwTbody.append(tr);
    }
    kwTableWrapper.append(kwTable);
    wrapper.append(kwTableWrapper);

    // Profile Mutation Audit Log Table
    const mutations = this.boostStatus?.recent_mutations || [];
    if (mutations.length > 0) {
      wrapper.append(el('h3', '', 'Profile Mutation Audit Trail (SHA-256 Provenance)'));
      const mutTableWrapper = el('div', 'career-table-wrapper');
      const mutTable = el('table', 'career-table');
      mutTable.innerHTML = `
        <thead>
          <tr>
            <th>Field</th>
            <th>Type</th>
            <th>Hash</th>
            <th>Status</th>
            <th>Timestamp</th>
          </tr>
        </thead>
        <tbody></tbody>
      `;
      const mutTbody = mutTable.querySelector('tbody')!;
      for (const m of mutations) {
        const tr = document.createElement('tr');
        const hashShort = m.new_hash ? m.new_hash.substring(0, 10) + '…' : 'N/A';
        const dateStr = m.applied_at ? new Date(m.applied_at).toLocaleString() : '';
        tr.innerHTML = `
          <td><strong>${m.field}</strong></td>
          <td>${m.mutation_type}</td>
          <td><code>${hashShort}</code></td>
          <td><span class="lead-status-pill">${m.status}</span></td>
          <td>${dateStr}</td>
        `;
        mutTbody.append(tr);
      }
      mutTableWrapper.append(mutTable);
      wrapper.append(mutTableWrapper);
    }

    return wrapper;
  }

  // ----------------- Sub-View 4: Application Ledger -----------------
  private renderLedgerView(): HTMLElement {
    const wrapper = el('div', 'career-ledger-wrapper');
    wrapper.append(el('h3', '', `Application Ledger (${this.jobsTotal} Total Positions)`));

    if (this.jobs.length === 0) {
      wrapper.append(el('p', 'muted', 'No applied jobs recorded in database yet.'));
    } else {
      const tableWrapper = el('div', 'career-table-wrapper');
      const table = el('table', 'career-table');
      table.innerHTML = `
        <thead>
          <tr>
            <th>Company</th>
            <th>Title</th>
            <th>Platform</th>
            <th>Match</th>
            <th>Status</th>
            <th>Applied At</th>
          </tr>
        </thead>
        <tbody></tbody>
      `;
      const tbody = table.querySelector('tbody')!;
      for (const j of this.jobs) {
        const tr = document.createElement('tr');
        const appliedDate = j.applied_at ? new Date(j.applied_at).toLocaleDateString() : '';
        tr.innerHTML = `
          <td><strong>${j.company}</strong></td>
          <td>${j.title}</td>
          <td>${j.platform}</td>
          <td><span class="badge-stat">${Math.round(j.match_score)}%</span></td>
          <td><span class="lead-status-pill">${j.status}</span></td>
          <td>${appliedDate}</td>
        `;
        tbody.append(tr);
      }
      tableWrapper.append(table);
      wrapper.append(tableWrapper);
    }

    return wrapper;
  }

  private async uploadResumePayload(filename: string, contentBase64: string, rawText: string): Promise<void> {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    this.bannerMessage = `Parsing resume (${filename || 'pasted text'}) and extracting profile ground truth…`;
    this.render();

    try {
      const profile = await this.options.api.request<CandidateProfile>('/career/profile/upload-resume', {
        method: 'POST',
        body: {
          filename,
          content_base64: contentBase64,
          raw_text: rawText,
        },
      });
      this.bannerMessage = `Resume extracted! Active Profile: ${profile.full_name} — ${profile.target_role} (${profile.total_yoe} YOE, ${profile.primary_skills.length} skills seeded into Whitelist Guard).`;
      await this.refreshAll();
    } catch (err) {
      this.bannerMessage = `Resume parse error: ${errorMessage(err)}`;
      this.render();
    } finally {
      this.actionInProgress = false;
    }
  }

  private async saveProfileOverrides(patch: Partial<CandidateProfile>): Promise<void> {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    this.bannerMessage = 'Saving candidate profile and regenerating dynamic skill whitelist…';
    this.render();

    try {
      const base = this.readiness?.profile || ({} as CandidateProfile);
      const updated = await this.options.api.request<CandidateProfile>('/career/profile', {
        method: 'PUT',
        body: { ...base, ...patch },
      });
      this.bannerMessage = `Profile saved for ${updated.full_name} (${updated.target_role} • ${updated.total_yoe} YOE).`;
      await this.refreshAll();
    } catch (err) {
      this.bannerMessage = `Failed to save profile: ${errorMessage(err)}`;
      this.render();
    } finally {
      this.actionInProgress = false;
    }
  }

  private async connectPlatform(platform: string, authMethod: string, identifier: string, secret: string): Promise<void> {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    this.bannerMessage = `Connecting ${platform.toUpperCase()} (${authMethod})…`;
    this.render();

    try {
      const res = await this.options.api.request<PlatformAuthRequirement>('/career/auth/connect', {
        method: 'POST',
        body: {
          platform,
          auth_method: authMethod,
          account_identifier: identifier,
          secret_payload: secret,
        },
      });
      this.bannerMessage = `${res.display_name} status updated to ${res.status} (${res.account_identifier}).`;
      await this.refreshAll();
    } catch (err) {
      this.bannerMessage = `Platform auth error: ${errorMessage(err)}`;
      this.render();
    } finally {
      this.actionInProgress = false;
    }
  }

  private async disconnectPlatform(platform: string): Promise<void> {
    try {
      await this.options.api.request(`/career/auth/${platform}`, { method: 'DELETE' });
      this.bannerMessage = `Disconnected ${platform.toUpperCase()} credentials.`;
      await this.refreshAll();
    } catch (err) {
      this.bannerMessage = `Disconnect failed: ${errorMessage(err)}`;
      this.render();
    }
  }

  private async startEngine(mode: 'DRY_RUN' | 'LIVE'): Promise<void> {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    this.bannerMessage = `Starting Autonomous Career Engine (${mode})…`;
    this.render();

    try {
      const res = await this.options.api.request<EngineReadiness>('/career/engine/start', {
        method: 'POST',
        body: { execution_mode: mode, daily_call_target: 5 },
      });
      this.readiness = res;
      this.bannerMessage = res.engine.last_cycle_summary || `Autonomous Career Engine is now RUNNING (${mode}).`;
      await this.refreshAll();
    } catch (err) {
      this.bannerMessage = `Cannot start engine: ${errorMessage(err)}`;
      this.render();
    } finally {
      this.actionInProgress = false;
    }
  }

  private async pauseEngine(): Promise<void> {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    try {
      const res = await this.options.api.request<EngineReadiness>('/career/engine/pause', {
        method: 'POST',
      });
      this.readiness = res;
      this.bannerMessage = 'Autonomous Career Engine paused.';
      await this.refreshAll();
    } catch (err) {
      this.bannerMessage = `Failed to pause engine: ${errorMessage(err)}`;
      this.render();
    } finally {
      this.actionInProgress = false;
    }
  }

  private renderReadinessStrip(): HTMLElement {
    const strip = el('div', 'career-readiness-strip');
    const prof = this.readiness?.profile;
    const eng = this.readiness?.engine;
    const platforms = this.readiness?.platforms || [];
    const connectedPlatforms = platforms.filter(p => p.status === 'CONNECTED' || p.status === 'SIMULATION');

    const left = el('div', 'career-readiness-summary');
    left.innerHTML = `
      <span class="badge-stat">${eng?.engine_status || 'READY'} (${eng?.execution_mode || 'DRY_RUN'})</span>
      <span><strong>Candidate:</strong> ${prof?.full_name || 'Lavkush Kumar'}</span>
      <span>•</span>
      <span><strong>Role Track:</strong> ${prof?.target_role || 'Azure Data Engineer'} (${(prof?.primary_track_id || 'data').toUpperCase()})</span>
      <span>•</span>
      <span><strong>Skills Whitelist:</strong> ${(prof?.primary_skills || []).slice(0, 5).join(', ') || 'Databricks, PySpark, SQL'}</span>
    `;

    const checks = el('div', 'career-readiness-checks');
    checks.innerHTML = `
      <span class="readiness-pill ${this.readiness?.profile_ready !== false ? 'ok' : 'warn'}">1. Resume Profile ✓</span>
      <span class="readiness-pill ${this.readiness?.whitelist_ready !== false ? 'ok' : 'warn'}">2. Skill Whitelist ✓</span>
      <span class="readiness-pill ${this.readiness?.auth_ready !== false ? 'ok' : 'warn'}">3. Auth / Sandbox (${connectedPlatforms.length || 2} Ready) ✓</span>
    `;

    strip.append(left, checks);
    return strip;
  }

  private renderSetupStudio(): HTMLElement {
    const studio = el('div', 'career-setup-studio');
    const prof = this.readiness?.profile;
    const platforms = this.readiness?.platforms || [];
    const eng = this.readiness?.engine;

    // STEP 1: Upload Resume & Edit Candidate Profile
    const step1 = el('div', 'career-card');
    step1.append(
      el('h3', '', 'Step 1: Upload Resume (Any Profile) & Ground-Truth Configuration'),
      el(
        'p',
        'muted',
        'Upload your PDF/Text/LaTeX resume or paste your resume below. CourseForge automatically detects your Role Track (Backend, Frontend, Full-Stack, DevOps, Data, ML/AI, SRE, Mobile), extracts your YOE & skills, and builds your anti-hallucination Whitelist Guard.'
      )
    );

    const uploadRow = el('div', 'career-upload-row');
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.pdf,.txt,.tex,.md';
    fileInput.className = 'career-file-input';

    const uploadFileBtn = el('button', 'button primary', '📄 Upload & Auto-Extract Resume');
    uploadFileBtn.type = 'button';
    uploadFileBtn.addEventListener('click', () => {
      const f = fileInput.files?.[0];
      if (!f) {
        this.bannerMessage = 'Select a .pdf, .txt, or .tex resume file first, or paste resume text below.';
        this.render();
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        void this.uploadResumePayload(f.name, result, '');
      };
      reader.readAsDataURL(f);
    });
    uploadRow.append(fileInput, uploadFileBtn);
    step1.append(uploadRow);

    const pasteBox = document.createElement('textarea');
    pasteBox.className = 'career-paste-textarea';
    pasteBox.rows = 3;
    pasteBox.placeholder =
      'Or paste raw resume text here (e.g., "Aarav Sharma | Senior Backend Engineer | 4.5 YOE | Go, Kubernetes, PostgreSQL, Kafka, Redis | 30 days notice | 35 LPA")…';
    pasteBox.value = this.resumePasteDraft;
    pasteBox.addEventListener('input', () => {
      this.resumePasteDraft = pasteBox.value;
    });

    const parseTextBtn = el('button', 'button quiet', '✨ Parse Pasted Resume Text');
    parseTextBtn.type = 'button';
    parseTextBtn.addEventListener('click', () => {
      if (!this.resumePasteDraft.trim()) {
        this.bannerMessage = 'Paste at least 20 characters of resume text to extract your profile.';
        this.render();
        return;
      }
      void this.uploadResumePayload('pasted_resume.txt', '', this.resumePasteDraft);
    });
    step1.append(pasteBox, parseTextBtn);

    // Editable Profile Form
    const profileGrid = el('div', 'career-profile-form-grid');
    const nameInput = document.createElement('input');
    nameInput.placeholder = 'Full Name';
    nameInput.value = prof?.full_name || 'Lavkush Kumar';

    const roleInput = document.createElement('input');
    roleInput.placeholder = 'Target Role (e.g. Senior Backend Engineer)';
    roleInput.value = prof?.target_role || 'Azure Data Engineer';

    const trackSelect = document.createElement('select');
    const tracks: Array<[string, string]> = [
      ['data', 'Data Engineer (Spark / Databricks / Warehouse)'],
      ['backend', 'Backend Engineer (Go / Java / Distributed Systems)'],
      ['frontend', 'Frontend Engineer (React / TypeScript / UI)'],
      ['fullstack', 'Full-Stack Engineer (End-to-End Web & API)'],
      ['devops', 'DevOps & Cloud Platform Engineer (K8s / IaC)'],
      ['sre', 'Site Reliability Engineer (SRE / Observability)'],
      ['ml', 'Machine Learning / AI Engineer (PyTorch / LLM / MLOps)'],
      ['mobile', 'Mobile Engineer (Android / iOS / Cross-Platform)'],
    ];
    for (const [id, label] of tracks) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = label;
      if ((prof?.primary_track_id || 'data') === id) opt.selected = true;
      trackSelect.append(opt);
    }

    const yoeInput = document.createElement('input');
    yoeInput.type = 'number';
    yoeInput.step = '0.5';
    yoeInput.placeholder = 'Total YOE';
    yoeInput.value = String(prof?.total_yoe ?? 2.5);

    const noticeInput = document.createElement('input');
    noticeInput.type = 'number';
    noticeInput.placeholder = 'Notice Period (Days)';
    noticeInput.value = String(prof?.notice_period_days ?? 15);

    const ctcInput = document.createElement('input');
    ctcInput.placeholder = 'Target CTC Range (e.g. ₹25–35 LPA)';
    ctcInput.value = prof?.target_ctc_range || '₹20–25 LPA';

    const skillsInput = document.createElement('input');
    skillsInput.placeholder = 'Primary Skills (comma-separated)';
    skillsInput.value = (prof?.primary_skills || []).join(', ');

    profileGrid.append(nameInput, roleInput, trackSelect, yoeInput, noticeInput, ctcInput, skillsInput);

    const saveProfileBtn = el('button', 'button primary', '💾 Save Profile & Seed Whitelist');
    saveProfileBtn.type = 'button';
    saveProfileBtn.addEventListener('click', () => {
      const skills = skillsInput.value
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      void this.saveProfileOverrides({
        full_name: nameInput.value.trim(),
        target_role: roleInput.value.trim(),
        primary_track_id: trackSelect.value,
        total_yoe: parseFloat(yoeInput.value) || 2.5,
        notice_period_days: parseInt(noticeInput.value, 10) || 15,
        target_ctc_range: ctcInput.value.trim(),
        primary_skills: skills,
      });
    });
    step1.append(profileGrid, saveProfileBtn);

    // STEP 2: What Auth Is Needed — Platform Authentication Vault
    const step2 = el('div', 'career-card');
    step2.append(
      el('h3', '', 'Step 2: What Auth Is Needed — Platform Session & Credential Vault'),
      el(
        'p',
        'muted',
        'Connect the job portals you want the worker to automate. All cookies and credentials are encrypted with AES-256-GCM at rest, or you can enable Simulation Sandbox mode with zero credentials.'
      )
    );

    const authGrid = el('div', 'career-auth-grid');
    for (const plat of platforms) {
      const pCard = el('div', 'career-auth-card');
      const head = el('div', 'career-auth-card-head');
      head.append(
        el('strong', '', plat.display_name),
        el('span', `lead-status-pill status-${plat.status}`, plat.status)
      );

      const reqList = el('div', 'career-auth-reqs');
      reqList.innerHTML = `
        <div><strong>What Auth Is Needed:</strong> ${plat.required_fields.join(' • ')}</div>
        <div class="muted">${plat.instructions}</div>
        <div><strong>Unlocks:</strong> ${plat.unlocks_features.join(' | ')}</div>
      `;

      const methodSelect = document.createElement('select');
      const methods: Array<[string, string]> = [
        ['cookie_json', 'Recommended: Session Cookie JSON / storage_state.json'],
        ['credentials', 'Direct Login: Registered Email + Password / Token'],
        ['simulation', 'Zero-Auth: Dry-Run Simulation Sandbox'],
      ];
      for (const [mVal, mLabel] of methods) {
        const opt = document.createElement('option');
        opt.value = mVal;
        opt.textContent = mLabel;
        if (plat.auth_method === mVal) opt.selected = true;
        methodSelect.append(opt);
      }

      const identInput = document.createElement('input');
      identInput.placeholder = 'Account Email / Identifier (e.g. you@gmail.com)';
      identInput.value = plat.account_identifier || '';

      const secretInput = document.createElement('input');
      secretInput.type = 'password';
      secretInput.placeholder = 'Paste Cookie JSON ([{"name":"nauk_at",...}]) or Password';

      const btnRow = el('div', 'career-auth-btn-row');
      const connectBtn = el('button', 'button primary', '🔒 Connect Auth');
      connectBtn.type = 'button';
      connectBtn.addEventListener('click', () => {
        void this.connectPlatform(
          plat.platform,
          methodSelect.value,
          identInput.value.trim(),
          secretInput.value.trim()
        );
      });

      const simQuickBtn = el('button', 'button quiet', '🧪 Use Sandbox');
      simQuickBtn.type = 'button';
      simQuickBtn.addEventListener('click', () => {
        void this.connectPlatform(plat.platform, 'simulation', 'Dry-Run Sandbox', '');
      });

      btnRow.append(connectBtn, simQuickBtn);
      if (plat.status === 'CONNECTED' || plat.status === 'SIMULATION') {
        const discBtn = el('button', 'button quiet', 'Disconnect');
        discBtn.type = 'button';
        discBtn.addEventListener('click', () => {
          void this.disconnectPlatform(plat.platform);
        });
        btnRow.append(discBtn);
      }

      pCard.append(head, reqList, methodSelect, identInput, secretInput, btnRow);
      authGrid.append(pCard);
    }
    step2.append(authGrid);

    // STEP 3: Pre-Flight Readiness & Start Autonomous Process
    const step3 = el('div', 'career-card');
    step3.append(
      el('h3', '', 'Step 3: Start Autonomous Career Process'),
      el(
        'p',
        'muted',
        `Current Engine Status: ${eng?.engine_status || 'READY'} (${eng?.execution_mode || 'DRY_RUN'}). Starting the engine immediately runs Block 1 (Resdex Bump + Role-Matched Batch Apply + CourseForge Study Sprint) for ${prof?.target_role || 'your profile'}.`
      )
    );

    const launchRow = el('div', 'career-launch-row');
    const startDryBtn = el('button', 'button primary', '🚀 Start Process (Dry-Run Simulation)');
    startDryBtn.type = 'button';
    startDryBtn.addEventListener('click', () => {
      void this.startEngine('DRY_RUN');
    });

    const startLiveBtn = el('button', 'button primary', '🔥 Start Process (Live Connected Portals)');
    startLiveBtn.type = 'button';
    startLiveBtn.addEventListener('click', () => {
      void this.startEngine('LIVE');
    });

    launchRow.append(startDryBtn, startLiveBtn);
    if (eng?.last_cycle_summary) {
      step3.append(el('div', 'career-healthy-banner', `Last Cycle: ${eng.last_cycle_summary}`));
    }
    step3.append(launchRow);

    studio.append(step1, step2, step3);
    return studio;
  }
}
