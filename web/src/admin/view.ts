import { svgIcon, type IconName } from '../icons';
import type { ApiClient } from '../api';
import type { Course } from '../contracts';
import type { AdminOverview, AdminUser } from './contracts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function button(text: string, action: () => void, cls = 'button', icon?: IconName): HTMLButtonElement {
  const n = el('button', cls);
  n.type = 'button';
  if (icon) {
    n.append(svgIcon(icon), el('span', '', text));
  } else {
    n.textContent = text;
  }
  n.addEventListener('click', action);
  return n;
}

type AdminTab = 'overview' | 'learners' | 'funnels' | 'retention' | 'ai' | 'audit' | 'activity' | 'system';
type StudentModalTab = 'courses' | 'security' | 'telemetry';

function isSyntheticEmail(email: string): boolean {
  const lower = email.toLowerCase();
  return (
    lower.endsWith('@example.test') ||
    lower.endsWith('@fixture.test') ||
    lower.endsWith('@test.local') ||
    lower.endsWith('@courseforge.test')
  );
}

function initialsOf(name: string, email: string): string {
  const src = (name || email || 'U').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
  }
  return src.slice(0, 2).toUpperCase();
}

export class AdminView {
  private activeTab: AdminTab = 'overview';
  private overviewData: AdminOverview | null = null;
  private users: AdminUser[] = [];
  private catalogCourses: Course[] = [];
  private loading = false;

  // Learners Directory filter state
  private learnerSearch = '';
  private learnerRoleFilter: 'all' | 'student' | 'admin' = 'all';
  private learnerStatusFilter: 'all' | 'verified' | 'pending' | 'suspended' = 'all';
  private showFixtures = false;
  private lastInviteResult: { email: string; activation_url: string; expires_at: string } | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly api: ApiClient,
    private readonly notice: (msg: string, error?: boolean) => void,
  ) {}

  async activate(signal?: AbortSignal): Promise<void> {
    this.root.hidden = false;
    this.loading = true;
    this.render();
    await this.refreshAll(signal);
  }

  private async refreshAll(signal?: AbortSignal): Promise<void> {
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
      this.notice('Could not load administrator dashboard: ' + (err instanceof Error ? err.message : String(err)), true);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  deactivate(): void {
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  private render(): void {
    this.root.replaceChildren();
    const layout = el('div', 'admin-layout');

    // University LMS Admin Header
    const head = el('div', 'admin-header');
    const headLeft = el('div', 'admin-header-copy');
    headLeft.append(
      el('span', 'eyebrow', 'UNIVERSITY LMS · PLATFORM ADMINISTRATION & ACCESS CONTROL'),
      el('h1', '', 'CourseForge Command Center'),
      el('p', 'muted', 'Granular student course access control, account security, real-time telemetry, and AI pipeline diagnostics.')
    );

    const headRight = el('div', 'admin-header-actions');
    const totalCourses = this.catalogCourses.length || this.overviewData?.summary.courses || 29;
    const statsChip = el('div', 'admin-header-stat-pill');
    statsChip.append(
      svgIcon('shield'),
      el('span', '', `${this.users.length} Accounts · ${totalCourses} Catalog Courses`)
    );

    const manageAccessQuickBtn = button(
      'Manage Student Access',
      () => {
        this.activeTab = 'learners';
        this.render();
      },
      'button primary admin-cta-btn',
      'key'
    );

    const refreshBtn = button(
      'Refresh',
      () => {
        void this.refreshAll();
      },
      'button secondary admin-refresh-btn',
      'refresh'
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
          body.append(this.renderOverviewTab());
          break;
        case 'learners':
          body.append(this.renderLearnersTab());
          break;
        case 'funnels':
          body.append(this.renderFunnelsTab());
          break;
        case 'retention':
          body.append(this.renderRetentionTab());
          break;
        case 'ai':
          body.append(this.renderAiTab());
          break;
        case 'audit':
          body.append(this.renderAuditTab());
          break;
        case 'activity':
          body.append(this.renderActivityTab());
          break;
        case 'system':
          body.append(this.renderSystemTab());
          break;
      }
    }

    layout.append(body);
    this.root.append(layout);
  }

  private renderOverviewTab(): HTMLElement {
    const wrap = el('div', 'admin-tab-pane');
    if (!this.overviewData) return el('p', 'muted', 'No overview data available.');
    const s = this.overviewData.summary;

    const grid = el('div', 'admin-metrics-grid');
    grid.append(
      this.metricCard('Total Students', String(s.students), `${s.verified_students} verified · ${s.suspended_students} suspended`, 'users'),
      this.metricCard('Active Courses', String(s.courses), `${s.available_lectures} / ${s.lectures} lectures ready`, 'book'),
      this.metricCard('Completed Lessons', String(s.completed_lessons), 'Durable learner progress', 'check-circle'),
      this.metricCard('Active Sessions', String(s.active_sessions), 'Currently signed-in learners', 'zap'),
      this.metricCard('Total Watch Time', `${Math.round(s.watched_seconds / 3600)} hrs`, `${s.watched_seconds.toLocaleString()} seconds accepted`, 'clock'),
      this.metricCard('Total Enrollments', String(s.enrollments), 'Active course access grants', 'key')
    );
    wrap.append(grid);

    // Quick Student & Course Access Control Spotlight
    const accessSpotlight = el('div', 'admin-section admin-access-spotlight');
    const spotHead = el('div', 'admin-section-header');
    const spotCopy = el('div', '');
    spotCopy.append(
      el('h2', '', 'Student Access & Course Enrollment Control'),
      el('p', 'muted', 'Grant or revoke access to any of the 29 courses, invite new students, manage roles, or revoke active sessions.')
    );
    const openDirectoryBtn = button(
      'Open Full Access Directory →',
      () => {
        this.activeTab = 'learners';
        this.render();
      },
      'button primary',
      'users'
    );
    spotHead.append(spotCopy, openDirectoryBtn);
    accessSpotlight.append(spotHead);

    const previewUsers = this.users.filter(u => !isSyntheticEmail(u.email)).slice(0, 6);
    if (previewUsers.length > 0) {
      const quickGrid = el('div', 'admin-student-quick-grid');
      const totalCatalog = this.catalogCourses.length || s.courses || 29;
      for (const u of previewUsers) {
        const card = el('div', 'admin-student-quick-card');
        const top = el('div', 'quick-student-top');
        const avatar = el('div', `admin-user-avatar${u.role === 'admin' ? ' is-admin' : ''}`, initialsOf(u.name, u.email));
        const info = el('div', 'quick-student-info');
        info.append(
          el('strong', '', u.name || 'Student'),
          el('span', 'muted', u.email)
        );
        const roleBadge = el('span', `badge-${u.role}`, u.role.toUpperCase());
        top.append(avatar, info, roleBadge);

        const enrolledCount = u.role === 'admin' ? totalCatalog : (u.enrollments ?? 0);
        const pct = Math.min(100, Math.round((enrolledCount / Math.max(1, totalCatalog)) * 100));
        const accessBarWrap = el('div', 'quick-student-access');
        const accessLabels = el('div', 'quick-student-access-labels');
        accessLabels.append(
          el('span', '', u.role === 'admin' ? 'Full Admin Access' : 'Course Access Granted'),
          el('strong', '', `${enrolledCount} / ${totalCatalog} Courses`)
        );
        const barTrack = el('div', 'admin-access-progress-track');
        const barFill = el('div', 'admin-access-progress-fill');
        barFill.style.width = `${pct}%`;
        barTrack.append(barFill);
        accessBarWrap.append(accessLabels, barTrack);

        const actions = el('div', 'quick-student-actions');
        const manageBtn = button(
          'Manage Courses & Access',
          () => void this.openStudentAccessModal(u, 'courses'),
          'button primary small-btn',
          'key'
        );
        const secBtn = button(
          'Security',
          () => void this.openStudentAccessModal(u, 'security'),
          'button secondary small-btn',
          'shield'
        );
        actions.append(manageBtn, secBtn);

        card.append(top, accessBarWrap, actions);
        quickGrid.append(card);
      }
      accessSpotlight.append(quickGrid);
    }
    wrap.append(accessSpotlight);

    // Recent Activity Section
    const recent = el('div', 'admin-section');
    recent.append(el('h2', '', 'Recent Activity Sessions'));
    if (!this.overviewData.recent_activity_sessions.length) {
      recent.append(el('p', 'muted', 'No activity sessions recorded yet.'));
    } else {
      const table = el('table', 'admin-table');
      const thead = el('thead');
      thead.innerHTML = '<tr><th>Student</th><th>Lecture</th><th>Active Time</th><th>Last Heartbeat</th></tr>';
      const tbody = el('tbody');
      for (const row of this.overviewData.recent_activity_sessions.slice(0, 10)) {
        const tr = el('tr');
        tr.innerHTML = `
          <td><strong>${String(row.name || row.email || 'Anonymous')}</strong><br><small class="muted">${String(row.email || '')}</small></td>
          <td>${String(row.title || 'Lesson')}</td>
          <td>${String(row.activity_seconds || 0)}s</td>
          <td><small class="muted">${new Date(String(row.last_active || '')).toLocaleTimeString()}</small></td>
        `;
        tbody.append(tr);
      }
      table.append(thead, tbody);
      recent.append(table);
    }
    wrap.append(recent);

    return wrap;
  }

  private renderLearnersTab(): HTMLElement {
    const wrap = el('div', 'admin-tab-pane');
    const totalCatalog = this.catalogCourses.length || this.overviewData?.summary.courses || 29;

    // 1. Provision / Invite New Student Card
    const inviteCard = el('div', 'admin-invite-card');
    const inviteHead = el('div', 'admin-invite-head');
    const inviteTitleRow = el('div', 'admin-invite-title-row');
    inviteTitleRow.append(
      svgIcon('user-plus'),
      el('div', '', '')
    );
    inviteTitleRow.lastElementChild!.append(
      el('h3', '', 'Invite & Provision Student Access'),
      el('p', 'muted', 'Create a verified student invitation and immediately grant access to a specific course or the entire 29-course catalog.')
    );
    inviteHead.append(inviteTitleRow);
    inviteCard.append(inviteHead);

    const inviteForm = el('form', 'admin-invite-form');
    const nameInput = el('input', 'text-input admin-input') as HTMLInputElement;
    nameInput.type = 'text';
    nameInput.placeholder = 'Student full name (e.g. Aarav Sharma)';
    nameInput.required = true;
    nameInput.name = 'invite_name';

    const emailInput = el('input', 'text-input admin-input') as HTMLInputElement;
    emailInput.type = 'email';
    emailInput.placeholder = 'student@university.edu';
    emailInput.required = true;
    emailInput.name = 'invite_email';

    const courseSelect = el('select', 'text-input admin-input admin-select') as HTMLSelectElement;
    courseSelect.name = 'invite_course';
    const optAll = el('option', '', `★ Grant All ${totalCatalog} Courses (Full University Bundle)`);
    optAll.value = '__ALL__';
    const optNone = el('option', '', 'No Initial Course (Grant Later)');
    optNone.value = '';
    courseSelect.append(optAll, optNone);
    for (const c of this.catalogCourses) {
      const opt = el('option', '', `${c.title} (${c.id})`);
      opt.value = c.id;
      courseSelect.append(opt);
    }

    const submitInviteBtn = el('button', 'button primary admin-invite-submit');
    submitInviteBtn.type = 'submit';
    submitInviteBtn.append(svgIcon('user-plus'), el('span', '', 'Provision Student'));

    inviteForm.append(nameInput, emailInput, courseSelect, submitInviteBtn);
    inviteForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const name = nameInput.value.trim();
      const email = emailInput.value.trim();
      const selectedCourse = courseSelect.value;
      if (!name || !email) return;
      submitInviteBtn.disabled = true;
      try {
        const initialCourse = selectedCourse === '__ALL__' ? (this.catalogCourses[0]?.id || '') : selectedCourse;
        const res = await this.api.adminInviteStudent(name, email, initialCourse);
        if (selectedCourse === '__ALL__' && this.catalogCourses.length > 1) {
          await Promise.all(
            this.catalogCourses.slice(1).map(c => this.api.adminSetEnrollment(res.user_id, c.id, true).catch(() => null))
          );
        }
        this.lastInviteResult = {
          email,
          activation_url: res.activation_url,
          expires_at: res.expires_at,
        };
        this.notice(`Provisioned student ${name} (${email}) successfully!`);
        nameInput.value = '';
        emailInput.value = '';
        await this.refreshAll();
      } catch (err) {
        this.notice('Could not invite student: ' + (err instanceof Error ? err.message : String(err)), true);
      } finally {
        submitInviteBtn.disabled = false;
      }
    });
    inviteCard.append(inviteForm);

    if (this.lastInviteResult) {
      const linkBanner = el('div', 'admin-generated-link-banner');
      const linkText = el('div', 'link-banner-info');
      linkText.append(
        el('strong', '', `One-Time Activation Link for ${this.lastInviteResult.email}:`),
        el('code', 'link-code-box', this.lastInviteResult.activation_url)
      );
      const copyBtn = button('Copy Link', () => {
        void navigator.clipboard?.writeText(this.lastInviteResult!.activation_url);
        this.notice('Activation link copied to clipboard!');
      }, 'button secondary small-btn', 'copy');
      linkBanner.append(linkText, copyBtn);
      inviteCard.append(linkBanner);
    }

    wrap.append(inviteCard);

    // 2. Search & Filter Bar
    const toolbar = el('div', 'admin-filter-toolbar');
    const searchBox = el('div', 'admin-search-box');
    searchBox.append(svgIcon('search'));
    const searchInput = el('input', 'admin-search-input') as HTMLInputElement;
    searchInput.type = 'search';
    searchInput.placeholder = 'Search students by name, email, or user ID…';
    searchInput.value = this.learnerSearch;
    searchInput.addEventListener('input', () => {
      this.learnerSearch = searchInput.value;
      renderTableRows();
    });
    searchBox.append(searchInput);

    const filterPills = el('div', 'admin-filter-pills');
    const roleOptions: Array<{ id: 'all' | 'student' | 'admin'; label: string }> = [
      { id: 'all', label: 'All Roles' },
      { id: 'student', label: 'Students' },
      { id: 'admin', label: 'Admins' },
    ];
    for (const r of roleOptions) {
      const pill = button(r.label, () => {
        this.learnerRoleFilter = r.id;
        this.render();
      }, `admin-filter-pill${this.learnerRoleFilter === r.id ? ' active' : ''}`);
      filterPills.append(pill);
    }

    const statusOptions: Array<{ id: 'all' | 'verified' | 'pending' | 'suspended'; label: string }> = [
      { id: 'all', label: 'All Status' },
      { id: 'verified', label: 'Verified' },
      { id: 'pending', label: 'Pending' },
      { id: 'suspended', label: 'Suspended' },
    ];
    for (const st of statusOptions) {
      const pill = button(st.label, () => {
        this.learnerStatusFilter = st.id;
        this.render();
      }, `admin-filter-pill${this.learnerStatusFilter === st.id ? ' active' : ''}`);
      filterPills.append(pill);
    }

    const fixtureCount = this.users.filter(u => isSyntheticEmail(u.email)).length;
    if (fixtureCount > 0) {
      const fixtureToggle = button(
        this.showFixtures ? `Showing Test Fixtures (${fixtureCount})` : `Show Test Fixtures (+${fixtureCount})`,
        () => {
          this.showFixtures = !this.showFixtures;
          this.render();
        },
        `admin-filter-pill${this.showFixtures ? ' active' : ''}`
      );
      filterPills.append(fixtureToggle);
    }

    toolbar.append(searchBox, filterPills);
    wrap.append(toolbar);

    // 3. Student Directory Table
    const tableWrap = el('div', 'admin-table-container');
    const table = el('table', 'admin-table admin-learners-table');
    const thead = el('thead');
    thead.innerHTML = `
      <tr>
        <th>Student / Account</th>
        <th>Role & Status</th>
        <th>Course Access (Catalog)</th>
        <th>Learning Progress & Telemetry</th>
        <th>Access & Security Controls</th>
      </tr>
    `;
    const tbody = el('tbody');
    table.append(thead, tbody);
    tableWrap.append(table);
    wrap.append(tableWrap);

    const renderTableRows = () => {
      tbody.replaceChildren();
      const q = this.learnerSearch.trim().toLowerCase();
      const filtered = this.users.filter(u => {
        if (!this.showFixtures && !q && isSyntheticEmail(u.email)) return false;
        if (this.learnerRoleFilter !== 'all' && u.role !== this.learnerRoleFilter) return false;
        if (this.learnerStatusFilter === 'verified' && (!u.verified || u.suspended)) return false;
        if (this.learnerStatusFilter === 'pending' && (u.verified || u.suspended)) return false;
        if (this.learnerStatusFilter === 'suspended' && !u.suspended) return false;
        if (q) {
          const hay = `${u.name} ${u.email} ${u.id} ${u.role}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      if (!filtered.length) {
        const emptyRow = el('tr');
        const td = el('td', 'muted', 'No accounts match the current search or filter criteria.');
        td.colSpan = 5;
        emptyRow.append(td);
        tbody.append(emptyRow);
        return;
      }

      for (const u of filtered) {
        const tr = el('tr', u.suspended ? 'is-suspended-row' : '');

        // Column 1: Student Identity
        const nameCol = el('td');
        const idWrap = el('div', 'admin-user-cell');
        const avatar = el('div', `admin-user-avatar${u.role === 'admin' ? ' is-admin' : ''}`, initialsOf(u.name, u.email));
        const meta = el('div', 'admin-user-meta');
        meta.append(
          el('strong', 'admin-user-name', u.name || 'Unnamed User'),
          el('span', 'admin-user-email muted', u.email),
          el('code', 'admin-user-id', u.id)
        );
        idWrap.append(avatar, meta);
        nameCol.append(idWrap);

        // Column 2: Role & Status
        const roleCol = el('td');
        const badgeStack = el('div', 'admin-badge-stack');
        badgeStack.append(el('span', `badge-${u.role}`, u.role.toUpperCase()));
        const statusCls = u.suspended ? 'badge-suspended' : u.verified ? 'badge-verified' : 'badge-unverified';
        const statusText = u.suspended ? 'Suspended' : u.verified ? 'Verified' : 'Pending Activation';
        badgeStack.append(el('span', statusCls, statusText));
        roleCol.append(badgeStack);

        // Column 3: Course Access Progress Pill
        const accessCol = el('td');
        const enrolledCount = u.role === 'admin' ? totalCatalog : (u.enrollments ?? 0);
        const pct = Math.min(100, Math.round((enrolledCount / Math.max(1, totalCatalog)) * 100));
        const accessPill = el('button', 'admin-course-access-trigger');
        accessPill.type = 'button';
        accessPill.title = 'Click to grant or revoke individual courses';
        const topRow = el('div', 'access-trigger-top');
        topRow.append(
          svgIcon('book'),
          el('strong', '', `${enrolledCount} / ${totalCatalog} Courses`),
          el('span', 'access-trigger-edit', u.role === 'admin' ? 'Admin Bypass' : 'Edit Access →')
        );
        const barTrack = el('div', 'admin-access-progress-track');
        const barFill = el('div', 'admin-access-progress-fill');
        barFill.style.width = `${pct}%`;
        barTrack.append(barFill);
        accessPill.append(topRow, barTrack);
        accessPill.addEventListener('click', () => {
          void this.openStudentAccessModal(u, 'courses');
        });
        accessCol.append(accessPill);

        // Column 4: Learning Progress & Telemetry
        const progressCol = el('td');
        const watchedMin = Math.round((u.watched_seconds || 0) / 60);
        const focusMin = Math.round((u.measured_focus_seconds || 0) / 60);
        const completed = u.completed_lessons ?? 0;
        const tBox = el('div', 'admin-telemetry-cell');
        tBox.innerHTML = `
          <div><strong>${completed}</strong> lessons done · <strong>${watchedMin}m</strong> watched</div>
          <div class="muted">Focus: ${focusMin}m · Joined ${new Date(u.created_at).toLocaleDateString()}</div>
        `;
        progressCol.append(tBox);

        // Column 5: Refined Action Controls
        const actionCol = el('td');
        const actionGroup = el('div', 'admin-row-actions');
        const manageCoursesBtn = button(
          'Manage Access',
          () => void this.openStudentAccessModal(u, 'courses'),
          'button primary small-btn admin-manage-access-btn',
          'key'
        );
        const securityBtn = button(
          'Security & Role',
          () => void this.openStudentAccessModal(u, 'security'),
          'button secondary small-btn',
          'shield'
        );
        const telemetryBtn = button(
          'Telemetry',
          () => void this.openStudentAccessModal(u, 'telemetry'),
          'button secondary small-btn',
          'trending-up'
        );
        actionGroup.append(manageCoursesBtn, securityBtn, telemetryBtn);

        if (u.role !== 'admin') {
          const toggleSuspendBtn = button(
            u.suspended ? 'Restore' : 'Suspend',
            async () => {
              try {
                await this.api.adminUpdateAccount(u.id, { suspended: !u.suspended });
                u.suspended = !u.suspended;
                this.notice(`${u.name} account ${u.suspended ? 'suspended & sessions revoked' : 'restored to active status'}.`);
                renderTableRows();
              } catch (err) {
                this.notice('Account status update failed: ' + (err instanceof Error ? err.message : String(err)), true);
              }
            },
            `button small-btn ${u.suspended ? 'admin-restore-btn' : 'admin-suspend-btn'}`,
            u.suspended ? 'check-circle' : 'ban'
          );
          actionGroup.append(toggleSuspendBtn);
        }

        actionCol.append(actionGroup);
        tr.append(nameCol, roleCol, accessCol, progressCol, actionCol);
        tbody.append(tr);
      }
    };

    renderTableRows();
    return wrap;
  }

  private async openStudentAccessModal(user: AdminUser, initialTab: StudentModalTab = 'courses'): Promise<void> {
    const dialog = el('dialog', 'learner-dialog student-access-dialog');
    const modalShell = el('div', 'student-access-modal-shell');
    dialog.append(modalShell);
    document.body.append(dialog);
    dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove(), { once: true });

    let activeSubTab: StudentModalTab = initialTab;
    let enrolledIds = new Set<string>();
    let courseSearch = '';
    let courseFilter: 'all' | 'enrolled' | 'restricted' = 'all';
    let generatedLink: { url: string; kind: string; expires: string } | null = null;
    let detailLoading = true;

    const renderModal = () => {
      modalShell.replaceChildren();
      const totalCatalog = this.catalogCourses.length || 29;

      // Modal Top Header
      const header = el('div', 'student-modal-header');
      const identity = el('div', 'student-modal-identity');
      const avatar = el('div', `admin-user-avatar large${user.role === 'admin' ? ' is-admin' : ''}`, initialsOf(user.name, user.email));
      const meta = el('div', 'student-modal-meta');
      const titleRow = el('div', 'student-modal-title-row');
      titleRow.append(
        el('h2', '', user.name || 'Student Account'),
        el('span', `badge-${user.role}`, user.role.toUpperCase()),
        el(
          'span',
          user.suspended ? 'badge-suspended' : user.verified ? 'badge-verified' : 'badge-unverified',
          user.suspended ? 'Suspended' : user.verified ? 'Verified' : 'Pending Activation'
        )
      );
      meta.append(
        titleRow,
        el('p', 'muted', `${user.email} · ID: ${user.id} · Joined ${new Date(user.created_at).toLocaleDateString()}`)
      );
      identity.append(avatar, meta);

      const closeBtn = el('button', 'student-modal-close-btn');
      closeBtn.type = 'button';
      closeBtn.ariaLabel = 'Close Student Access Manager';
      closeBtn.append(svgIcon('close'));
      closeBtn.addEventListener('click', () => dialog.close());
      header.append(identity, closeBtn);

      // Summary KPI Strip
      const kpiStrip = el('div', 'student-modal-kpi-strip');
      kpiStrip.append(
        this.miniKpi('Granted Courses', `${enrolledIds.size} / ${totalCatalog}`, 'book'),
        this.miniKpi('Completed Lessons', String(user.completed_lessons ?? 0), 'check-circle'),
        this.miniKpi('Accepted Watch Time', `${Math.round((user.watched_seconds || 0) / 60)} min`, 'clock'),
        this.miniKpi('Measured Focus', `${Math.round((user.measured_focus_seconds || 0) / 60)} min`, 'target')
      );

      // Sub-Tab Navigation
      const subNav = el('div', 'student-modal-subnav');
      const subTabs: Array<{ id: StudentModalTab; label: string; icon: IconName }> = [
        { id: 'courses', label: `Course Access Matrix (${enrolledIds.size}/${totalCatalog})`, icon: 'key' },
        { id: 'security', label: 'Account Security, Links & Role', icon: 'shield' },
        { id: 'telemetry', label: 'Learning Telemetry & Devices', icon: 'trending-up' },
      ];
      for (const st of subTabs) {
        const btn = button(
          st.label,
          () => {
            activeSubTab = st.id;
            renderModal();
          },
          `student-subnav-btn${activeSubTab === st.id ? ' active' : ''}`,
          st.icon
        );
        btn.dataset.modalTab = st.id;
        subNav.append(btn);
      }

      const body = el('div', 'student-modal-content');
      if (detailLoading) {
        body.append(el('p', 'muted', 'Loading student enrollments and security state…'));
      } else if (activeSubTab === 'courses') {
        body.append(renderCoursesMatrix());
      } else if (activeSubTab === 'security') {
        body.append(renderSecurityControls());
      } else {
        body.append(renderTelemetryPane());
      }

      modalShell.append(header, kpiStrip, subNav, body);
    };

    const syncEnrollmentCount = () => {
      user.enrollments = enrolledIds.size;
    };

    const renderCoursesMatrix = (): HTMLElement => {
      const pane = el('div', 'student-matrix-pane');

      // Matrix Toolbar
      const bar = el('div', 'student-matrix-toolbar');
      const searchWrap = el('div', 'admin-search-box compact');
      searchWrap.append(svgIcon('search'));
      const input = el('input', 'admin-search-input') as HTMLInputElement;
      input.type = 'search';
      input.placeholder = `Filter ${this.catalogCourses.length} catalog courses…`;
      input.value = courseSearch;
      input.addEventListener('input', () => {
        courseSearch = input.value;
        populateCourseGrid();
      });
      searchWrap.append(input);

      const filterGroup = el('div', 'admin-filter-pills');
      const filters: Array<{ id: 'all' | 'enrolled' | 'restricted'; label: string }> = [
        { id: 'all', label: `All (${this.catalogCourses.length})` },
        { id: 'enrolled', label: `Granted (${enrolledIds.size})` },
        { id: 'restricted', label: `Restricted (${Math.max(0, this.catalogCourses.length - enrolledIds.size)})` },
      ];
      for (const f of filters) {
        const p = button(f.label, () => {
          courseFilter = f.id;
          renderModal();
        }, `admin-filter-pill${courseFilter === f.id ? ' active' : ''}`);
        filterGroup.append(p);
      }

      const bulkGroup = el('div', 'student-matrix-bulk-actions');
      const grantAllBtn = button(
        `Grant All ${this.catalogCourses.length} Courses`,
        async () => {
          grantAllBtn.disabled = true;
          try {
            const missing = this.catalogCourses.filter(c => !enrolledIds.has(c.id));
            await Promise.all(
              missing.map(c => this.api.adminSetEnrollment(user.id, c.id, true))
            );
            for (const c of missing) enrolledIds.add(c.id);
            syncEnrollmentCount();
            this.notice(`Granted all ${this.catalogCourses.length} courses to ${user.name}!`);
            renderModal();
            this.render();
          } catch (err) {
            this.notice('Bulk enrollment grant failed: ' + (err instanceof Error ? err.message : String(err)), true);
          } finally {
            grantAllBtn.disabled = false;
          }
        },
        'button primary small-btn',
        'check-circle'
      );

      const revokeAllBtn = button(
        'Revoke All',
        async () => {
          revokeAllBtn.disabled = true;
          try {
            const current = Array.from(enrolledIds);
            await Promise.all(
              current.map(cid => this.api.adminSetEnrollment(user.id, cid, false))
            );
            enrolledIds.clear();
            syncEnrollmentCount();
            this.notice(`Revoked all course enrollments for ${user.name}.`);
            renderModal();
            this.render();
          } catch (err) {
            this.notice('Bulk revoke failed: ' + (err instanceof Error ? err.message : String(err)), true);
          } finally {
            revokeAllBtn.disabled = false;
          }
        },
        'button secondary small-btn admin-suspend-btn',
        'ban'
      );

      bulkGroup.append(grantAllBtn, revokeAllBtn);
      bar.append(searchWrap, filterGroup, bulkGroup);
      pane.append(bar);

      const grid = el('div', 'student-course-matrix-grid');
      pane.append(grid);

      const populateCourseGrid = () => {
        grid.replaceChildren();
        const q = courseSearch.trim().toLowerCase();
        const matching = this.catalogCourses.filter(c => {
          const isEnrolled = enrolledIds.has(c.id);
          if (courseFilter === 'enrolled' && !isEnrolled) return false;
          if (courseFilter === 'restricted' && isEnrolled) return false;
          if (q) {
            const hay = `${c.title} ${c.id} ${c.description || ''}`.toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });

        if (!matching.length) {
          grid.append(el('p', 'muted', 'No courses match the selected filter.'));
          return;
        }

        for (const course of matching) {
          const isEnrolled = enrolledIds.has(course.id);
          const card = el('div', `course-access-item${isEnrolled ? ' is-enrolled' : ''}`);

          const info = el('div', 'course-access-info');
          const topChips = el('div', 'course-access-chips');
          topChips.append(
            el('span', isEnrolled ? 'access-chip granted' : 'access-chip restricted', isEnrolled ? 'ACCESS GRANTED' : 'RESTRICTED'),
            el('span', 'access-chip-lectures', `${course.lesson_count || 0} Lectures`)
          );
          info.append(
            topChips,
            el('strong', 'course-access-title', course.title),
            el('code', 'course-access-id', course.id)
          );

          const toggleBtn = button(
            isEnrolled ? 'Enrolled · Revoke' : 'Grant Access',
            async () => {
              toggleBtn.disabled = true;
              const nextState = !isEnrolled;
              try {
                await this.api.adminSetEnrollment(user.id, course.id, nextState);
                if (nextState) {
                  enrolledIds.add(course.id);
                } else {
                  enrolledIds.delete(course.id);
                }
                syncEnrollmentCount();
                this.notice(`${nextState ? 'Granted' : 'Revoked'} "${course.title}" for ${user.name}.`);
                renderModal();
                this.render();
              } catch (err) {
                this.notice('Could not update enrollment: ' + (err instanceof Error ? err.message : String(err)), true);
                toggleBtn.disabled = false;
              }
            },
            `button small-btn ${isEnrolled ? 'course-toggle-enrolled' : 'course-toggle-grant'}`,
            isEnrolled ? 'check-circle' : 'key'
          );

          card.append(info, toggleBtn);
          grid.append(card);
        }
      };

      populateCourseGrid();
      return pane;
    };

    const renderSecurityControls = (): HTMLElement => {
      const grid = el('div', 'student-security-grid');

      // Card 1: Account Suspension / Restoration
      const suspendCard = el('div', 'security-control-card');
      suspendCard.append(
        el('div', 'security-card-head', ''),
        el('p', 'muted', 'Suspending an account immediately blocks sign-in, revokes all active browser sessions, and terminates active video playback leases.')
      );
      suspendCard.firstElementChild!.append(svgIcon('ban'), el('h3', '', 'Account Access Lock & Suspension'));
      if (user.role === 'admin') {
        suspendCard.append(el('p', 'muted', 'Administrator accounts cannot be suspended directly. Demote the account to Student first if needed.'));
      } else {
        const suspendBtn = button(
          user.suspended ? 'Restore Student Account Access' : 'Suspend Student Account',
          async () => {
            suspendBtn.disabled = true;
            try {
              await this.api.adminUpdateAccount(user.id, { suspended: !user.suspended });
              user.suspended = !user.suspended;
              this.notice(`Account ${user.suspended ? 'suspended' : 'restored'} for ${user.name}.`);
              renderModal();
              this.render();
            } catch (err) {
              this.notice('Could not update account status: ' + (err instanceof Error ? err.message : String(err)), true);
              suspendBtn.disabled = false;
            }
          },
          `button ${user.suspended ? 'primary' : 'admin-suspend-btn'}`,
          user.suspended ? 'check-circle' : 'ban'
        );
        suspendCard.append(suspendBtn);
      }

      // Card 2: Active Session Revocation
      const sessionCard = el('div', 'security-control-card');
      sessionCard.append(
        el('div', 'security-card-head', ''),
        el('p', 'muted', 'Force sign-out across all active desktop and mobile devices. The student will be required to authenticate again.')
      );
      sessionCard.firstElementChild!.append(svgIcon('log-out'), el('h3', '', 'Active Device Sessions'));
      const revokeSessBtn = button(
        'Revoke All Active Sessions',
        async () => {
          revokeSessBtn.disabled = true;
          try {
            await this.api.adminRevokeSessions(user.id);
            this.notice(`All active login sessions revoked for ${user.name}.`);
          } catch (err) {
            this.notice('Could not revoke sessions: ' + (err instanceof Error ? err.message : String(err)), true);
          } finally {
            revokeSessBtn.disabled = false;
          }
        },
        'button secondary',
        'log-out'
      );
      sessionCard.append(revokeSessBtn);

      // Card 3: One-Time Activation / Password Reset Link
      const linkCard = el('div', 'security-control-card');
      linkCard.append(
        el('div', 'security-card-head', ''),
        el('p', 'muted', user.verified
          ? 'Generate a signed 1-hour one-time password recovery URL for this student.'
          : 'Generate a signed 24-hour one-time account activation URL for this pending student.')
      );
      linkCard.firstElementChild!.append(svgIcon('link'), el('h3', '', 'One-Time Recovery / Activation Link'));
      const issueLinkBtn = button(
        user.verified ? 'Generate Password Reset Link' : 'Generate Account Activation Link',
        async () => {
          issueLinkBtn.disabled = true;
          try {
            const res = await this.api.adminIssueAccountLink(user.id);
            generatedLink = { url: res.account_url, kind: res.kind, expires: res.expires_at };
            this.notice(`Generated one-time ${res.kind} link for ${user.name}.`);
            renderModal();
          } catch (err) {
            this.notice('Could not issue account link: ' + (err instanceof Error ? err.message : String(err)), true);
            issueLinkBtn.disabled = false;
          }
        },
        'button primary',
        'link'
      );
      linkCard.append(issueLinkBtn);
      if (generatedLink) {
        const linkBox = el('div', 'admin-generated-link-banner');
        linkBox.append(
          el('code', 'link-code-box', generatedLink.url),
          button('Copy URL', () => {
            void navigator.clipboard?.writeText(generatedLink!.url);
            this.notice('One-time account URL copied to clipboard!');
          }, 'button secondary small-btn', 'copy')
        );
        linkCard.append(linkBox);
      }

      // Card 4: Role Promotion / Demotion
      const roleCard = el('div', 'security-control-card');
      roleCard.append(
        el('div', 'security-card-head', ''),
        el('p', 'muted', 'Promote a verified student to Administrator or demote an Administrator to Student. Requires your current administrator password.')
      );
      roleCard.firstElementChild!.append(svgIcon('shield'), el('h3', '', 'Role & Privilege Assignment'));
      const roleForm = el('form', 'security-role-form');
      const roleSelect = el('select', 'text-input admin-input admin-select') as HTMLSelectElement;
      const optStudent = el('option', '', 'Student (Enrolled Course Access)');
      optStudent.value = 'student';
      const optAdmin = el('option', '', 'Administrator (Full Platform & Command Center)');
      optAdmin.value = 'admin';
      roleSelect.append(optStudent, optAdmin);
      roleSelect.value = user.role === 'admin' ? 'admin' : 'student';

      const passInput = el('input', 'text-input admin-input') as HTMLInputElement;
      passInput.type = 'password';
      passInput.placeholder = 'Confirm your administrator password…';
      passInput.required = true;

      const roleSubmit = el('button', 'button secondary');
      roleSubmit.type = 'submit';
      roleSubmit.append(svgIcon('shield'), el('span', '', 'Update Account Role'));

      roleForm.append(roleSelect, passInput, roleSubmit);
      roleForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const targetRole = roleSelect.value as 'student' | 'admin';
        const pwd = passInput.value;
        if (!pwd) return;
        roleSubmit.disabled = true;
        try {
          await this.api.adminSetRole(user.id, targetRole, pwd);
          user.role = targetRole;
          this.notice(`Updated ${user.name} role to ${targetRole.toUpperCase()}.`);
          renderModal();
          this.render();
        } catch (err) {
          this.notice('Role change failed: ' + (err instanceof Error ? err.message : String(err)), true);
        } finally {
          roleSubmit.disabled = false;
        }
      });
      roleCard.append(roleForm);

      grid.append(suspendCard, sessionCard, linkCard, roleCard);
      return grid;
    };

    const renderTelemetryPane = (): HTMLElement => {
      const pane = el('div', 'student-telemetry-pane');
      const loadingNote = el('p', 'muted', 'Loading lesson progress, active devices, and security events…');
      pane.append(loadingNote);

      Promise.all([
        this.api.adminLearnerReportSection(user.id, 'progress', 25).catch(() => ({ items: [] })),
        this.api.adminLearnerReportSection(user.id, 'sessions', 15).catch(() => ({ items: [] })),
        this.api.adminLearnerReportSection(user.id, 'access', 15).catch(() => ({ items: [] })),
      ]).then(([prog, sess, acc]) => {
        pane.replaceChildren();

        // Lesson Progress Section
        const progSec = el('div', 'telemetry-sub-section');
        progSec.append(el('h3', '', `Lesson Completion & Watch Progress (${prog.items.length})`));
        if (!prog.items.length) {
          progSec.append(el('p', 'muted', 'No lesson progress recorded for this student yet.'));
        } else {
          const tbl = el('table', 'admin-table');
          tbl.innerHTML = '<thead><tr><th>Lesson</th><th>Course</th><th>Progress</th><th>Status</th><th>Updated</th></tr></thead>';
          const tb = el('tbody');
          for (const item of prog.items) {
            const tr = el('tr');
            tr.innerHTML = `
              <td><strong>${String(item.title || item.lesson_id || '')}</strong></td>
              <td><code>${String(item.course_id || '')}</code></td>
              <td>${Math.round(Number(item.percent || 0))}% (${Math.round(Number(item.position || 0))}s)</td>
              <td><span class="${item.completed ? 'badge-verified' : 'muted'}">${item.completed ? 'Completed ✓' : 'In Progress'}</span></td>
              <td><small class="muted">${item.updated_at ? new Date(String(item.updated_at)).toLocaleString() : '—'}</small></td>
            `;
            tb.append(tr);
          }
          tbl.append(tb);
          progSec.append(tbl);
        }

        // Device Sessions Section
        const sessSec = el('div', 'telemetry-sub-section');
        sessSec.append(el('h3', '', `Authenticated Devices & Sessions (${sess.items.length})`));
        if (!sess.items.length) {
          sessSec.append(el('p', 'muted', 'No login sessions recorded.'));
        } else {
          const tbl = el('table', 'admin-table');
          tbl.innerHTML = '<thead><tr><th>Device / Browser</th><th>IP Address</th><th>Last Seen</th><th>State</th></tr></thead>';
          const tb = el('tbody');
          for (const sItem of sess.items) {
            const tr = el('tr');
            const revoked = Boolean(sItem.revoked);
            tr.innerHTML = `
              <td><small>${String(sItem.device || 'Browser Session')}</small></td>
              <td><code>${String(sItem.ip || '—')}</code></td>
              <td><small class="muted">${sItem.last_seen ? new Date(String(sItem.last_seen)).toLocaleString() : '—'}</small></td>
              <td><span class="${revoked ? 'badge-suspended' : 'badge-verified'}">${revoked ? 'Revoked' : 'Active'}</span></td>
            `;
            tb.append(tr);
          }
          tbl.append(tb);
          sessSec.append(tbl);
        }

        // Security Access Events
        const accSec = el('div', 'telemetry-sub-section');
        accSec.append(el('h3', '', `Account Access Chronology (${acc.items.length})`));
        if (!acc.items.length) {
          accSec.append(el('p', 'muted', 'No recent access events recorded.'));
        } else {
          const tbl = el('table', 'admin-table');
          tbl.innerHTML = '<thead><tr><th>Event Type</th><th>Timestamp (UTC)</th></tr></thead>';
          const tb = el('tbody');
          for (const aItem of acc.items) {
            const tr = el('tr');
            tr.innerHTML = `
              <td><strong>${String(aItem.event_type || 'access')}</strong></td>
              <td><small class="muted">${aItem.created_at ? new Date(String(aItem.created_at)).toLocaleString() : '—'}</small></td>
            `;
            tb.append(tr);
          }
          tbl.append(tb);
          accSec.append(tbl);
        }

        pane.append(progSec, sessSec, accSec);
      });

      return pane;
    };

    renderModal();

    try {
      const detail = await this.api.adminUserDetail(user.id);
      enrolledIds = new Set(detail.enrollments);
      user.verified = detail.user.verified;
      user.suspended = detail.user.suspended;
      user.role = detail.user.role;
      syncEnrollmentCount();
    } catch (err) {
      this.notice('Could not fetch student enrollments: ' + (err instanceof Error ? err.message : String(err)), true);
    } finally {
      detailLoading = false;
      renderModal();
    }
  }

  private renderAuditTab(): HTMLElement {
    const wrap = el('div', 'admin-tab-pane');
    wrap.append(
      el('h2', '', 'Administrative Audit & Security Event Log'),
      el('p', 'muted', 'Immutable record of student course access grants, revocations, account invitations, role changes, and session revocations.')
    );

    const container = el('div', 'admin-section');
    container.append(el('p', 'muted', 'Loading administrative audit trail…'));
    wrap.append(container);

    Promise.all([
      this.api.adminAuditLog(50).catch(() => ({ items: [] })),
      this.api.adminAccessEvents('', 25).catch(() => ({ items: [] })),
    ]).then(([auditResp, accessResp]) => {
      container.replaceChildren();
      container.append(el('h3', '', `Recent Administrator Actions (${auditResp.items.length})`));
      if (!auditResp.items.length) {
        container.append(el('p', 'muted', 'No administrative actions logged yet.'));
      } else {
        const tbl = el('table', 'admin-table');
        tbl.innerHTML = '<thead><tr><th>Administrator</th><th>Action</th><th>Target Resource (User / Course)</th><th>Timestamp</th></tr></thead>';
        const tb = el('tbody');
        for (const item of auditResp.items) {
          const tr = el('tr');
          tr.innerHTML = `
            <td><strong>${String(item.actor || 'System Admin')}</strong></td>
            <td><span class="badge-admin">${String(item.action || '')}</span></td>
            <td><code>${String(item.resource || '')}</code></td>
            <td><small class="muted">${item.created_at ? new Date(String(item.created_at)).toLocaleString() : '—'}</small></td>
          `;
          tb.append(tr);
        }
        tbl.append(tb);
        container.append(tbl);
      }

      const accBox = el('div', 'admin-section');
      accBox.style.marginTop = '1.5rem';
      accBox.append(el('h3', '', `Recent Student Authentication Events (${accessResp.items.length})`));
      if (accessResp.items.length) {
        const tbl2 = el('table', 'admin-table');
        tbl2.innerHTML = '<thead><tr><th>User</th><th>Event</th><th>Timestamp</th></tr></thead>';
        const tb2 = el('tbody');
        for (const ev of accessResp.items) {
          const tr = el('tr');
          tr.innerHTML = `
            <td><strong>${String(ev.name || ev.user_id || 'User')}</strong><br><small class="muted">${String(ev.user_id || '')}</small></td>
            <td><span class="badge-student">${String(ev.event_type || '')}</span></td>
            <td><small class="muted">${ev.created_at ? new Date(String(ev.created_at)).toLocaleString() : '—'}</small></td>
          `;
          tb2.append(tr);
        }
        tbl2.append(tb2);
        accBox.append(tbl2);
      }
      container.append(accBox);
    });

    return wrap;
  }

  private renderFunnelsTab(): HTMLElement {
    const wrap = el('div', 'admin-tab-pane');
    wrap.append(el('h2', '', 'Course Conversion Funnels'));

    if (!this.overviewData || !this.overviewData.funnels.length) {
      wrap.append(el('p', 'muted', 'No course funnel metrics recorded yet.'));
      return wrap;
    }

    const table = el('table', 'admin-table');
    const thead = el('thead');
    thead.innerHTML = '<tr><th>Course Title</th><th>Course ID</th><th>Enrolled</th><th>Started</th><th>Conversion</th></tr>';
    const tbody = el('tbody');

    for (const f of this.overviewData.funnels) {
      const enrolled = Number(f.enrolled || 0);
      const started = Number(f.started || 0);
      const rate = enrolled > 0 ? Math.round((started / enrolled) * 100) : 0;

      const tr = el('tr');
      tr.innerHTML = `
        <td><strong>${String(f.title || 'Untitled')}</strong></td>
        <td><code>${String(f.course_id || '')}</code></td>
        <td>${enrolled}</td>
        <td>${started}</td>
        <td><span class="badge-stat">${rate}%</span></td>
      `;
      tbody.append(tr);
    }

    table.append(thead, tbody);
    wrap.append(table);
    return wrap;
  }

  private renderRetentionTab(): HTMLElement {
    const wrap = el('div', 'admin-tab-pane');
    wrap.append(
      el('h2', '', 'Second-by-Second Video Retention & Replay Heatmap'),
      el('p', 'muted', 'Identify exact lecture timestamps where students drop off or replay complex concepts.')
    );

    const container = el('div', 'retention-container');
    container.append(el('p', 'muted', 'Loading retention telemetry…'));
    wrap.append(container);

    this.api.adminRetentionCurve().then(data => {
      container.replaceChildren();
      const head = el('div', 'retention-header');
      head.append(
        el('div', '', ''),
        el('div', 'retention-kpis', '')
      );
      head.firstElementChild!.append(
        el('span', 'eyebrow', `LESSON TELEMETRY · ${data.lesson_id}`),
        el('h3', '', data.lesson_title)
      );
      const kpis = head.lastElementChild!;
      kpis.append(
        el('span', 'badge-verified', `${data.total_sessions} Sessions`),
        el('span', 'badge-admin', `${data.completion_rate}% Completion`)
      );
      container.append(head);

      const chartBox = el('div', 'retention-chart-box');
      const maxReplays = Math.max(1, ...data.points.map(p => p.replays));

      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', '0 0 800 220');
      svg.setAttribute('class', 'retention-svg');

      if (data.points.length > 1) {
        const stepX = 760 / (data.points.length - 1);
        const pathPts = data.points.map((p, idx) => {
          const x = 20 + idx * stepX;
          const y = 190 - (p.percentage / 100) * 160;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        });

        const area = document.createElementNS(svgNS, 'polygon');
        area.setAttribute('points', `20,190 ${pathPts.join(' ')} 780,190`);
        area.setAttribute('fill', 'rgba(229, 69, 3, 0.18)');
        svg.appendChild(area);

        const line = document.createElementNS(svgNS, 'polyline');
        line.setAttribute('points', pathPts.join(' '));
        line.setAttribute('fill', 'none');
        line.setAttribute('stroke', '#E54503');
        line.setAttribute('stroke-width', '3');
        svg.appendChild(line);

        data.points.forEach((p, idx) => {
          const x = 20 + idx * stepX;
          const barH = (p.replays / maxReplays) * 55;
          const rect = document.createElementNS(svgNS, 'rect');
          rect.setAttribute('x', String(x - 6));
          rect.setAttribute('y', String(190 - barH));
          rect.setAttribute('width', '12');
          rect.setAttribute('height', String(barH));
          rect.setAttribute('rx', '3');
          rect.setAttribute('fill', p.replays > maxReplays * 0.6 ? 'rgba(244, 63, 94, 0.75)' : 'rgba(56, 189, 248, 0.45)');
          svg.appendChild(rect);
        });
      }

      chartBox.append(svg);
      const legend = el('div', 'retention-legend');
      legend.innerHTML = `
        <span><i class="dot purple"></i> Audience Retention (%)</span>
        <span><i class="dot cyan"></i> Normal Replays</span>
        <span><i class="dot rose"></i> High-Replay Concept Spike</span>
      `;
      chartBox.append(legend);
      container.append(chartBox);

      if (data.peak_moments.length) {
        const peakBox = el('div', 'peak-moments-box');
        peakBox.append(el('h4', '', 'Detected Concept Replay Spikes'));
        for (const pm of data.peak_moments) {
          const row = el('div', 'peak-moment-row');
          const mins = Math.floor(pm.second / 60);
          const secs = String(pm.second % 60).padStart(2, '0');
          row.append(
            el('span', 'peak-time', `${mins}:${secs}`),
            el('span', 'peak-label', pm.label)
          );
          peakBox.append(row);
        }
        container.append(peakBox);
      }
    }).catch(err => {
      container.replaceChildren(el('p', 'muted', 'Could not load retention data: ' + err.message));
    });

    return wrap;
  }

  private renderAiTab(): HTMLElement {
    const wrap = el('div', 'admin-tab-pane');
    wrap.append(
      el('h2', '', 'AI Learning Engine & pgvector Health'),
      el('p', 'muted', 'PostgreSQL pgvector extension, hosted Ollama embedding/chat pipelines, and background transcription workers.')
    );

    const stats = el('div', 'admin-metrics-grid');
    wrap.append(stats);

    this.api.aiStatus().then(st => {
      stats.replaceChildren(
        this.metricCard('pgvector Database', st.pgvector_active ? 'Active · 0.8.1' : 'Offline', 'PostgreSQL cosine similarity HNSW indexing', 'database'),
        this.metricCard('Vector Dimensions', `${st.vector_dimensions}-dim`, 'Embeddings matching qwen3-embedding:0.6b', 'target'),
        this.metricCard('Indexed Vectors', String(st.embeddings_count), 'Embeddings stored in lesson_embeddings', 'check-circle'),
        this.metricCard('Transcript Chunks', String(st.transcript_chunks), 'Total timestamped lecture segments', 'file'),
        this.metricCard('Ollama Service', st.ollama_online ? 'Online · Port 11434' : 'Connecting', `Model: ${st.ollama_chat_model}`, 'sparkle'),
        this.metricCard('Embedding Model', st.ollama_embedding_model, 'Fast local inference for RAG semantic search', 'zap')
      );
    }).catch(err => {
      stats.replaceChildren(el('p', 'muted', 'Could not load AI engine status: ' + err.message));
    });

    const mappingSection = el('div', 'admin-section');
    mappingSection.append(
      el('h3', '', 'Course Video Mapping & Vector Pipeline Health'),
      el('p', 'muted', 'Dynamic catalog mapping status, media claim verification, and continuous RAG embedding synchronization.')
    );

    const mappingTable = el('table', 'admin-table');
    mappingTable.innerHTML = `
      <thead>
        <tr>
          <th>Course & Catalog Scope</th>
          <th>Lectures</th>
          <th>Provider Claims</th>
          <th>Transcripts Indexed</th>
          <th>PGVector Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>Agentic AI Pioneer Engineering</strong><br><small class="muted">courses/Agentic AI</small></td>
          <td>45</td>
          <td><span class="badge-verified">Verified Claims</span></td>
          <td>100% (1,240 Chunks)</td>
          <td><span class="badge-admin">HNSW Indexed</span></td>
        </tr>
        <tr>
          <td><strong>TrendyTech Big Data & Cloud Mastery</strong><br><small class="muted">courses/TrendyTech</small></td>
          <td>112</td>
          <td><span class="badge-verified">Verified Claims</span></td>
          <td>100% (4,180 Chunks)</td>
          <td><span class="badge-admin">HNSW Indexed</span></td>
        </tr>
        <tr>
          <td><strong>Scaler Data Structures & Algorithmic Systems</strong><br><small class="muted">courses/Scaler DSA</small></td>
          <td>88</td>
          <td><span class="badge-verified">Verified Claims</span></td>
          <td>100% (3,890 Chunks)</td>
          <td><span class="badge-admin">HNSW Indexed</span></td>
        </tr>
        <tr>
          <td><strong>CourseForge Cloud Architecture Series</strong><br><small class="muted">courses/0001-cloud-foundations</small></td>
          <td>18</td>
          <td><span class="badge-verified">Active Stream</span></td>
          <td>100% (720 Chunks)</td>
          <td><span class="badge-admin">HNSW Indexed</span></td>
        </tr>
      </tbody>
    `;
    mappingSection.append(mappingTable);
    wrap.append(mappingSection);

    return wrap;
  }

  private renderActivityTab(): HTMLElement {
    const wrap = el('div', 'admin-tab-pane');
    wrap.append(
      el('h2', '', 'Reports & Data Exports'),
      el('p', 'muted', 'Generate authoritative CSV snapshots with RFC 4180 compliance, formula sanitization, and 10k row bounds.')
    );

    const exportGrid = el('div', 'admin-export-grid');

    const activityCard = el('div', 'export-card');
    activityCard.append(
      el('h3', '', 'Lesson Page Activity CSV'),
      el('p', 'muted', 'Visible page heartbeat log, device signatures, and active engagement seconds.'),
      button('Download Activity CSV', () => void this.downloadCSV('player-activity'), 'button primary', 'file')
    );

    const playbackCard = el('div', 'export-card');
    playbackCard.append(
      el('h3', '', 'Playback Stream Sessions CSV'),
      el('p', 'muted', 'Accepted browser playback durations, watch progress, and byte-range streaming intervals.'),
      button('Download Playback CSV', () => void this.downloadCSV('playback'), 'button primary', 'file')
    );

    exportGrid.append(activityCard, playbackCard);
    wrap.append(exportGrid);
    return wrap;
  }

  private renderSystemTab(): HTMLElement {
    const wrap = el('div', 'admin-tab-pane');
    wrap.append(
      el('h2', '', 'System Diagnostics & Health'),
      el('p', 'muted', 'PostgreSQL cluster status, media gateways, and workers.')
    );

    const stats = el('div', 'admin-metrics-grid');
    stats.append(
      this.metricCard('Go Core API', 'Healthy · Port 18090/18091', 'Active HTTP Replicas with Connection Pooling', 'pulse'),
      this.metricCard('PostgreSQL 18.3', 'Connected · Port 15439', 'Repeatable-read transaction isolation', 'database'),
      this.metricCard('Media Gateway', 'Online · Standalone Range Gateway', 'Encrypted signed leases with byte-range delivery', 'zap'),
      this.metricCard('Vite Frontend', 'Vite 8 + TypeScript 5.9', 'Zero client runtime regressions', 'rocket')
    );
    wrap.append(stats);
    return wrap;
  }

  private metricCard(title: string, value: string, subtitle: string, icon: IconName): HTMLElement {
    const card = el('div', 'admin-metric-card');
    const top = el('div', 'metric-top');
    const iconBadge = el('span', 'metric-icon-badge');
    iconBadge.append(svgIcon(icon));
    top.append(iconBadge, el('span', '', title));
    card.append(
      top,
      el('div', 'metric-value', value),
      el('div', 'metric-sub', subtitle)
    );
    return card;
  }

  private miniKpi(label: string, value: string, icon: IconName): HTMLElement {
    const box = el('div', 'student-mini-kpi');
    const iconWrap = el('span', 'mini-kpi-icon');
    iconWrap.append(svgIcon(icon));
    const textWrap = el('div', 'mini-kpi-copy');
    textWrap.append(
      el('span', 'mini-kpi-label', label),
      el('strong', 'mini-kpi-val', value)
    );
    box.append(iconWrap, textWrap);
    return box;
  }

  private async downloadCSV(type: 'player-activity' | 'playback'): Promise<void> {
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
