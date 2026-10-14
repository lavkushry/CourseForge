import { svgIcon } from '../icons';
import type { AdminHost } from './host';
import { button, el, initialsOf, isSyntheticEmail } from './helpers';

export function renderLearnersTab(host: AdminHost): HTMLElement {
  const wrap = el('div', 'admin-tab-pane');
  const totalCatalog = host.catalogCourses.length || host.overviewData?.summary.courses || 29;

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
  for (const c of host.catalogCourses) {
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
      const initialCourse = selectedCourse === '__ALL__' ? (host.catalogCourses[0]?.id || '') : selectedCourse;
      const res = await host.api.adminInviteStudent(name, email, initialCourse);
      if (selectedCourse === '__ALL__' && host.catalogCourses.length > 1) {
        await Promise.all(
          host.catalogCourses.slice(1).map(c => host.api.adminSetEnrollment(res.user_id, c.id, true).catch(() => null))
        );
      }
      host.lastInviteResult = {
        email,
        activation_url: res.activation_url,
        expires_at: res.expires_at,
      };
      host.notice(`Provisioned student ${name} (${email}) successfully!`);
      nameInput.value = '';
      emailInput.value = '';
      await host.refreshAll();
    } catch (err) {
      host.notice('Could not invite student: ' + (err instanceof Error ? err.message : String(err)), true);
    } finally {
      submitInviteBtn.disabled = false;
    }
  });
  inviteCard.append(inviteForm);

  if (host.lastInviteResult) {
    const linkBanner = el('div', 'admin-generated-link-banner');
    const linkText = el('div', 'link-banner-info');
    linkText.append(
      el('strong', '', `One-Time Activation Link for ${host.lastInviteResult.email}:`),
      el('code', 'link-code-box', host.lastInviteResult.activation_url)
    );
    const copyBtn = button('Copy Link', () => {
      void navigator.clipboard?.writeText(host.lastInviteResult!.activation_url);
      host.notice('Activation link copied to clipboard!');
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
  searchInput.value = host.learnerSearch;
  searchInput.addEventListener('input', () => {
    host.learnerSearch = searchInput.value;
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
      host.learnerRoleFilter = r.id;
      host.render();
    }, `admin-filter-pill${host.learnerRoleFilter === r.id ? ' active' : ''}`);
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
      host.learnerStatusFilter = st.id;
      host.render();
    }, `admin-filter-pill${host.learnerStatusFilter === st.id ? ' active' : ''}`);
    filterPills.append(pill);
  }

  const fixtureCount = host.users.filter(u => isSyntheticEmail(u.email)).length;
  if (fixtureCount > 0) {
    const fixtureToggle = button(
      host.showFixtures ? `Showing Test Fixtures (${fixtureCount})` : `Show Test Fixtures (+${fixtureCount})`,
      () => {
        host.showFixtures = !host.showFixtures;
        host.render();
      },
      `admin-filter-pill${host.showFixtures ? ' active' : ''}`
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
    const q = host.learnerSearch.trim().toLowerCase();
    const filtered = host.users.filter(u => {
      if (!host.showFixtures && !q && isSyntheticEmail(u.email)) return false;
      if (host.learnerRoleFilter !== 'all' && u.role !== host.learnerRoleFilter) return false;
      if (host.learnerStatusFilter === 'verified' && (!u.verified || u.suspended)) return false;
      if (host.learnerStatusFilter === 'pending' && (u.verified || u.suspended)) return false;
      if (host.learnerStatusFilter === 'suspended' && !u.suspended) return false;
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
        void host.openStudentAccessModal(u, 'courses');
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
        () => void host.openStudentAccessModal(u, 'courses'),
        'button primary small-btn admin-manage-access-btn',
        'key'
      );
      const securityBtn = button(
        'Security & Role',
        () => void host.openStudentAccessModal(u, 'security'),
        'button secondary small-btn',
        'shield'
      );
      const telemetryBtn = button(
        'Telemetry',
        () => void host.openStudentAccessModal(u, 'telemetry'),
        'button secondary small-btn',
        'trending-up'
      );
      actionGroup.append(manageCoursesBtn, securityBtn, telemetryBtn);

      if (u.role !== 'admin') {
        const toggleSuspendBtn = button(
          u.suspended ? 'Restore' : 'Suspend',
          async () => {
            try {
              await host.api.adminUpdateAccount(u.id, { suspended: !u.suspended });
              u.suspended = !u.suspended;
              host.notice(`${u.name} account ${u.suspended ? 'suspended & sessions revoked' : 'restored to active status'}.`);
              renderTableRows();
            } catch (err) {
              host.notice('Account status update failed: ' + (err instanceof Error ? err.message : String(err)), true);
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
