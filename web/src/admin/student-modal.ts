import { svgIcon, type IconName } from '../icons';
import type { AdminHost } from './host';
import { button, el, initialsOf, type StudentModalTab } from './helpers';
import type { AdminUser } from './contracts';

export async function openStudentAccessModal(
  host: AdminHost,
  user: AdminUser,
  initialTab: StudentModalTab = 'courses',
): Promise<void> {
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
    const totalCatalog = host.catalogCourses.length || 29;

    // Modal Top Header
    const header = el('div', 'student-modal-header');
    const identity = el('div', 'student-modal-identity');
    const avatar = el(
      'div',
      `admin-user-avatar large${user.role === 'admin' ? ' is-admin' : ''}`,
      initialsOf(user.name, user.email),
    );
    const meta = el('div', 'student-modal-meta');
    const titleRow = el('div', 'student-modal-title-row');
    titleRow.append(
      el('h2', '', user.name || 'Student Account'),
      el('span', `badge-${user.role}`, user.role.toUpperCase()),
      el(
        'span',
        user.suspended ? 'badge-suspended' : user.verified ? 'badge-verified' : 'badge-unverified',
        user.suspended ? 'Suspended' : user.verified ? 'Verified' : 'Pending Activation',
      ),
    );
    meta.append(
      titleRow,
      el('p', 'muted', `${user.email} · ID: ${user.id} · Joined ${new Date(user.created_at).toLocaleDateString()}`),
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
      host.miniKpi('Granted Courses', `${enrolledIds.size} / ${totalCatalog}`, 'book'),
      host.miniKpi('Completed Lessons', String(user.completed_lessons ?? 0), 'check-circle'),
      host.miniKpi('Accepted Watch Time', `${Math.round((user.watched_seconds || 0) / 60)} min`, 'clock'),
      host.miniKpi('Measured Focus', `${Math.round((user.measured_focus_seconds || 0) / 60)} min`, 'target'),
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
        st.icon,
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
    input.placeholder = `Filter ${host.catalogCourses.length} catalog courses…`;
    input.value = courseSearch;
    input.addEventListener('input', () => {
      courseSearch = input.value;
      populateCourseGrid();
    });
    searchWrap.append(input);

    const filterGroup = el('div', 'admin-filter-pills');
    const filters: Array<{ id: 'all' | 'enrolled' | 'restricted'; label: string }> = [
      { id: 'all', label: `All (${host.catalogCourses.length})` },
      { id: 'enrolled', label: `Granted (${enrolledIds.size})` },
      { id: 'restricted', label: `Restricted (${Math.max(0, host.catalogCourses.length - enrolledIds.size)})` },
    ];
    for (const f of filters) {
      const p = button(
        f.label,
        () => {
          courseFilter = f.id;
          renderModal();
        },
        `admin-filter-pill${courseFilter === f.id ? ' active' : ''}`,
      );
      filterGroup.append(p);
    }

    const bulkGroup = el('div', 'student-matrix-bulk-actions');
    const grantAllBtn = button(
      `Grant All ${host.catalogCourses.length} Courses`,
      async () => {
        grantAllBtn.disabled = true;
        try {
          const missing = host.catalogCourses.filter(c => !enrolledIds.has(c.id));
          await Promise.all(missing.map(c => host.api.adminSetEnrollment(user.id, c.id, true)));
          for (const c of missing) enrolledIds.add(c.id);
          syncEnrollmentCount();
          host.notice(`Granted all ${host.catalogCourses.length} courses to ${user.name}!`);
          renderModal();
          host.render();
        } catch (err) {
          host.notice('Bulk enrollment grant failed: ' + (err instanceof Error ? err.message : String(err)), true);
        } finally {
          grantAllBtn.disabled = false;
        }
      },
      'button primary small-btn',
      'check-circle',
    );

    const revokeAllBtn = button(
      'Revoke All',
      async () => {
        revokeAllBtn.disabled = true;
        try {
          const current = Array.from(enrolledIds);
          await Promise.all(current.map(cid => host.api.adminSetEnrollment(user.id, cid, false)));
          enrolledIds.clear();
          syncEnrollmentCount();
          host.notice(`Revoked all course enrollments for ${user.name}.`);
          renderModal();
          host.render();
        } catch (err) {
          host.notice('Bulk revoke failed: ' + (err instanceof Error ? err.message : String(err)), true);
        } finally {
          revokeAllBtn.disabled = false;
        }
      },
      'button secondary small-btn admin-suspend-btn',
      'ban',
    );

    bulkGroup.append(grantAllBtn, revokeAllBtn);
    bar.append(searchWrap, filterGroup, bulkGroup);
    pane.append(bar);

    const grid = el('div', 'student-course-matrix-grid');
    pane.append(grid);

    const populateCourseGrid = () => {
      grid.replaceChildren();
      const q = courseSearch.trim().toLowerCase();
      const matching = host.catalogCourses.filter(c => {
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
          el(
            'span',
            isEnrolled ? 'access-chip granted' : 'access-chip restricted',
            isEnrolled ? 'ACCESS GRANTED' : 'RESTRICTED',
          ),
          el('span', 'access-chip-lectures', `${course.lesson_count || 0} Lectures`),
        );
        info.append(
          topChips,
          el('strong', 'course-access-title', course.title),
          el('code', 'course-access-id', course.id),
        );

        const toggleBtn = button(
          isEnrolled ? 'Enrolled · Revoke' : 'Grant Access',
          async () => {
            toggleBtn.disabled = true;
            const nextState = !isEnrolled;
            try {
              await host.api.adminSetEnrollment(user.id, course.id, nextState);
              if (nextState) {
                enrolledIds.add(course.id);
              } else {
                enrolledIds.delete(course.id);
              }
              syncEnrollmentCount();
              host.notice(`${nextState ? 'Granted' : 'Revoked'} "${course.title}" for ${user.name}.`);
              renderModal();
              host.render();
            } catch (err) {
              host.notice('Could not update enrollment: ' + (err instanceof Error ? err.message : String(err)), true);
              toggleBtn.disabled = false;
            }
          },
          `button small-btn ${isEnrolled ? 'course-toggle-enrolled' : 'course-toggle-grant'}`,
          isEnrolled ? 'check-circle' : 'key',
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
      el(
        'p',
        'muted',
        'Suspending an account immediately blocks sign-in, revokes all active browser sessions, and terminates active video playback leases.',
      ),
    );
    suspendCard.firstElementChild!.append(svgIcon('ban'), el('h3', '', 'Account Access Lock & Suspension'));
    if (user.role === 'admin') {
      suspendCard.append(
        el(
          'p',
          'muted',
          'Administrator accounts cannot be suspended directly. Demote the account to Student first if needed.',
        ),
      );
    } else {
      const suspendBtn = button(
        user.suspended ? 'Restore Student Account Access' : 'Suspend Student Account',
        async () => {
          suspendBtn.disabled = true;
          try {
            await host.api.adminUpdateAccount(user.id, { suspended: !user.suspended });
            user.suspended = !user.suspended;
            host.notice(`Account ${user.suspended ? 'suspended' : 'restored'} for ${user.name}.`);
            renderModal();
            host.render();
          } catch (err) {
            host.notice('Could not update account status: ' + (err instanceof Error ? err.message : String(err)), true);
            suspendBtn.disabled = false;
          }
        },
        `button ${user.suspended ? 'primary' : 'admin-suspend-btn'}`,
        user.suspended ? 'check-circle' : 'ban',
      );
      suspendCard.append(suspendBtn);
    }

    // Card 2: Active Session Revocation
    const sessionCard = el('div', 'security-control-card');
    sessionCard.append(
      el('div', 'security-card-head', ''),
      el(
        'p',
        'muted',
        'Force sign-out across all active desktop and mobile devices. The student will be required to authenticate again.',
      ),
    );
    sessionCard.firstElementChild!.append(svgIcon('log-out'), el('h3', '', 'Active Device Sessions'));
    const revokeSessBtn = button(
      'Revoke All Active Sessions',
      async () => {
        revokeSessBtn.disabled = true;
        try {
          await host.api.adminRevokeSessions(user.id);
          host.notice(`All active login sessions revoked for ${user.name}.`);
        } catch (err) {
          host.notice('Could not revoke sessions: ' + (err instanceof Error ? err.message : String(err)), true);
        } finally {
          revokeSessBtn.disabled = false;
        }
      },
      'button secondary',
      'log-out',
    );
    sessionCard.append(revokeSessBtn);

    // Card 3: One-Time Activation / Password Reset Link
    const linkCard = el('div', 'security-control-card');
    linkCard.append(
      el('div', 'security-card-head', ''),
      el(
        'p',
        'muted',
        user.verified
          ? 'Generate a signed 1-hour one-time password recovery URL for this student.'
          : 'Generate a signed 24-hour one-time account activation URL for this pending student.',
      ),
    );
    linkCard.firstElementChild!.append(svgIcon('link'), el('h3', '', 'One-Time Recovery / Activation Link'));
    const issueLinkBtn = button(
      user.verified ? 'Generate Password Reset Link' : 'Generate Account Activation Link',
      async () => {
        issueLinkBtn.disabled = true;
        try {
          const res = await host.api.adminIssueAccountLink(user.id);
          generatedLink = { url: res.account_url, kind: res.kind, expires: res.expires_at };
          host.notice(`Generated one-time ${res.kind} link for ${user.name}.`);
          renderModal();
        } catch (err) {
          host.notice('Could not issue account link: ' + (err instanceof Error ? err.message : String(err)), true);
          issueLinkBtn.disabled = false;
        }
      },
      'button primary',
      'link',
    );
    linkCard.append(issueLinkBtn);
    if (generatedLink) {
      const linkBox = el('div', 'admin-generated-link-banner');
      linkBox.append(
        el('code', 'link-code-box', generatedLink.url),
        button(
          'Copy URL',
          () => {
            void navigator.clipboard?.writeText(generatedLink!.url);
            host.notice('One-time account URL copied to clipboard!');
          },
          'button secondary small-btn',
          'copy',
        ),
      );
      linkCard.append(linkBox);
    }

    // Card 4: Role Promotion / Demotion
    const roleCard = el('div', 'security-control-card');
    roleCard.append(
      el('div', 'security-card-head', ''),
      el(
        'p',
        'muted',
        'Promote a verified student to Administrator or demote an Administrator to Student. Requires your current administrator password.',
      ),
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
    roleForm.addEventListener('submit', async ev => {
      ev.preventDefault();
      const targetRole = roleSelect.value as 'student' | 'admin';
      const pwd = passInput.value;
      if (!pwd) return;
      roleSubmit.disabled = true;
      try {
        await host.api.adminSetRole(user.id, targetRole, pwd);
        user.role = targetRole;
        host.notice(`Updated ${user.name} role to ${targetRole.toUpperCase()}.`);
        renderModal();
        host.render();
      } catch (err) {
        host.notice('Role change failed: ' + (err instanceof Error ? err.message : String(err)), true);
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
      host.api.adminLearnerReportSection(user.id, 'progress', 25).catch(() => ({ items: [] })),
      host.api.adminLearnerReportSection(user.id, 'sessions', 15).catch(() => ({ items: [] })),
      host.api.adminLearnerReportSection(user.id, 'access', 15).catch(() => ({ items: [] })),
    ]).then(([prog, sess, acc]) => {
      pane.replaceChildren();

      // Lesson Progress Section
      const progSec = el('div', 'telemetry-sub-section');
      progSec.append(el('h3', '', `Lesson Completion & Watch Progress (${prog.items.length})`));
      if (!prog.items.length) {
        progSec.append(el('p', 'muted', 'No lesson progress recorded for this student yet.'));
      } else {
        const tbl = el('table', 'admin-table');
        tbl.innerHTML =
          '<thead><tr><th>Lesson</th><th>Course</th><th>Progress</th><th>Status</th><th>Updated</th></tr></thead>';
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
        tbl.innerHTML =
          '<thead><tr><th>Device / Browser</th><th>IP Address</th><th>Last Seen</th><th>State</th></tr></thead>';
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
    const detail = await host.api.adminUserDetail(user.id);
    enrolledIds = new Set(detail.enrollments);
    user.verified = detail.user.verified;
    user.suspended = detail.user.suspended;
    user.role = detail.user.role;
    syncEnrollmentCount();
  } catch (err) {
    host.notice('Could not fetch student enrollments: ' + (err instanceof Error ? err.message : String(err)), true);
  } finally {
    detailLoading = false;
    renderModal();
  }
}
