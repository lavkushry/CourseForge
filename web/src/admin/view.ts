import { svgIcon, type IconName } from '../icons';
import type { ApiClient } from '../api';
import type { Course } from '../contracts';
import type { AdminOverview, AdminUser } from './contracts';
import { button, el, type AdminTab, type StudentModalTab } from './helpers';
import type { AdminHost } from './host';
import { renderOverviewTab } from './overview-tab';
import { renderLearnersTab } from './learners-tab';
import { openStudentAccessModal as openStudentModal } from './student-modal';
import { renderAuditTab, renderAiTab, renderSystemTab } from './ops-tabs';
import { renderFunnelsTab, renderRetentionTab, renderActivityTab } from './analytics-tabs';

export class AdminView implements AdminHost {
  activeTab: AdminTab = 'overview';
  overviewData: AdminOverview | null = null;
  users: AdminUser[] = [];
  catalogCourses: Course[] = [];
  loading = false;

  // Learners Directory filter state
  learnerSearch = '';
  learnerRoleFilter: 'all' | 'student' | 'admin' = 'all';
  learnerStatusFilter: 'all' | 'verified' | 'pending' | 'suspended' = 'all';
  showFixtures = false;
  lastInviteResult: { email: string; activation_url: string; expires_at: string } | null = null;

  constructor(
    readonly root: HTMLElement,
    readonly api: ApiClient,
    readonly notice: (msg: string, error?: boolean) => void,
  ) {}

  async activate(signal?: AbortSignal): Promise<void> {
    this.root.hidden = false;
    this.loading = true;
    this.render();
    await this.refreshAll(signal);
  }

  async refreshAll(signal?: AbortSignal): Promise<void> {
    this.loading = true;
    this.render();
    try {
      const [overview, learnerResp, coursesResp] = await Promise.all([
        this.api.adminOverview(signal),
        this.api.adminLearnerSummaries(100, '', '', signal).catch(() => this.api.adminUsers(100, '', signal)),
        this.api.courses('', signal).catch(() => ({ courses: [] as Course[] })),
      ]);
      this.overviewData = overview;
      this.users = learnerResp.users;
      this.catalogCourses = coursesResp.courses;
    } catch (err) {
      this.notice(
        'Could not load administrator dashboard: ' + (err instanceof Error ? err.message : String(err)),
        true,
      );
    } finally {
      this.loading = false;
      this.render();
    }
  }

  deactivate(): void {
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  render(): void {
    this.root.replaceChildren();
    const layout = el('div', 'admin-layout');

    // University LMS Admin Header
    const head = el('div', 'admin-header');
    const headLeft = el('div', 'admin-header-copy');
    headLeft.append(
      el('span', 'eyebrow', 'UNIVERSITY LMS · PLATFORM ADMINISTRATION & ACCESS CONTROL'),
      el('h1', '', 'CourseForge Command Center'),
      el(
        'p',
        'muted',
        'Granular student course access control, account security, real-time telemetry, and AI pipeline diagnostics.',
      ),
    );

    const headRight = el('div', 'admin-header-actions');
    const totalCourses = this.catalogCourses.length || this.overviewData?.summary.courses || 29;
    const statsChip = el('div', 'admin-header-stat-pill');
    statsChip.append(
      svgIcon('shield'),
      el('span', '', `${this.users.length} Accounts · ${totalCourses} Catalog Courses`),
    );

    const manageAccessQuickBtn = button(
      'Manage Student Access',
      () => {
        this.activeTab = 'learners';
        this.render();
      },
      'button primary admin-cta-btn',
      'key',
    );

    const refreshBtn = button(
      'Refresh',
      () => {
        void this.refreshAll();
      },
      'button secondary admin-refresh-btn',
      'refresh',
    );

    headRight.append(statsChip, manageAccessQuickBtn, refreshBtn);
    head.append(headLeft, headRight);

    // Tab Navigation (University LMS Pill Bar)
    const nav = el('nav', 'admin-nav');
    const tabs: Array<{ id: AdminTab; label: string; icon: IconName; badge?: string }> = [
      { id: 'overview', label: 'Overview Metrics', icon: 'grid' },
      { id: 'learners', label: 'Students & Access Control', icon: 'users', badge: String(this.users.length) },
      { id: 'funnels', label: 'Course Funnels', icon: 'trending-up' },
      { id: 'retention', label: 'Retention & Heatmaps', icon: 'flame' },
      { id: 'ai', label: 'AI Workers & Vectors', icon: 'sparkle' },
      { id: 'audit', label: 'Audit & Security Log', icon: 'shield' },
      { id: 'activity', label: 'Live Activity & Exports', icon: 'file' },
      { id: 'system', label: 'System Health', icon: 'database' },
    ];
    for (const t of tabs) {
      const btn = el('button', `admin-tab-btn${this.activeTab === t.id ? ' active' : ''}`);
      btn.type = 'button';
      btn.dataset.adminTab = t.id;
      btn.append(svgIcon(t.icon), el('span', '', t.label));
      if (t.badge) {
        btn.append(el('span', 'admin-tab-count', t.badge));
      }
      btn.addEventListener('click', () => {
        this.activeTab = t.id;
        this.render();
      });
      nav.append(btn);
    }

    layout.append(head, nav);

    const body = el('div', 'admin-content');
    if (this.loading) {
      body.append(el('p', 'muted', 'Loading administrator metrics…'));
    } else {
      switch (this.activeTab) {
        case 'overview':
          body.append(renderOverviewTab(this));
          break;
        case 'learners':
          body.append(renderLearnersTab(this));
          break;
        case 'funnels':
          body.append(renderFunnelsTab(this));
          break;
        case 'retention':
          body.append(renderRetentionTab(this));
          break;
        case 'ai':
          body.append(renderAiTab(this));
          break;
        case 'audit':
          body.append(renderAuditTab(this));
          break;
        case 'activity':
          body.append(renderActivityTab(this));
          break;
        case 'system':
          body.append(renderSystemTab(this));
          break;
      }
    }

    layout.append(body);
    this.root.append(layout);
  }

  async openStudentAccessModal(user: AdminUser, initialTab: StudentModalTab = 'courses'): Promise<void> {
    return openStudentModal(this, user, initialTab);
  }

  metricCard(title: string, value: string, subtitle: string, icon: IconName): HTMLElement {
    const card = el('div', 'admin-metric-card');
    const top = el('div', 'metric-top');
    const iconBadge = el('span', 'metric-icon-badge');
    iconBadge.append(svgIcon(icon));
    top.append(iconBadge, el('span', '', title));
    card.append(top, el('div', 'metric-value', value), el('div', 'metric-sub', subtitle));
    return card;
  }

  miniKpi(label: string, value: string, icon: IconName): HTMLElement {
    const box = el('div', 'student-mini-kpi');
    const iconWrap = el('span', 'mini-kpi-icon');
    iconWrap.append(svgIcon(icon));
    const textWrap = el('div', 'mini-kpi-copy');
    textWrap.append(el('span', 'mini-kpi-label', label), el('strong', 'mini-kpi-val', value));
    box.append(iconWrap, textWrap);
    return box;
  }

  async downloadCSV(type: 'player-activity' | 'playback'): Promise<void> {
    this.notice(`Generating ${type} CSV export…`);
    try {
      const csv = await this.api.exportReport(type);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `courseforge-${type}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      this.notice('Export downloaded successfully!');
    } catch (err) {
      this.notice('Export failed: ' + (err instanceof Error ? err.message : String(err)), true);
    }
  }
}
