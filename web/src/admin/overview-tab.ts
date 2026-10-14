import { emptyState, escapeHtml } from '../components';
import type { AdminHost } from './host';
import { button, el, initialsOf, isSyntheticEmail } from './helpers';

export function renderOverviewTab(host: AdminHost): HTMLElement {
  const wrap = el('div', 'admin-tab-pane');
  if (!host.overviewData)
    return emptyState({
      title: 'No overview data available.',
      description: 'Refresh the command center once metrics are ready.',
    });
  const s = host.overviewData.summary;

  const grid = el('div', 'admin-metrics-grid');
  grid.append(
    host.metricCard(
      'Total Students',
      String(s.students),
      `${s.verified_students} verified · ${s.suspended_students} suspended`,
      'users',
    ),
    host.metricCard(
      'Active Courses',
      String(s.courses),
      `${s.available_lectures} / ${s.lectures} lectures ready`,
      'book',
    ),
    host.metricCard('Completed Lessons', String(s.completed_lessons), 'Durable learner progress', 'check-circle'),
    host.metricCard('Active Sessions', String(s.active_sessions), 'Currently signed-in learners', 'zap'),
    host.metricCard(
      'Total Watch Time',
      `${Math.round(s.watched_seconds / 3600)} hrs`,
      `${s.watched_seconds.toLocaleString()} seconds accepted`,
      'clock',
    ),
    host.metricCard('Total Enrollments', String(s.enrollments), 'Active course access grants', 'key'),
  );
  wrap.append(grid);

  // Quick Student & Course Access Control Spotlight
  const accessSpotlight = el('div', 'admin-section admin-access-spotlight');
  const spotHead = el('div', 'admin-section-header');
  const spotCopy = el('div', '');
  spotCopy.append(
    el('h2', '', 'Student Access & Course Enrollment Control'),
    el(
      'p',
      'muted',
      'Grant or revoke access to any of the 29 courses, invite new students, manage roles, or revoke active sessions.',
    ),
  );
  const openDirectoryBtn = button(
    'Open Full Access Directory →',
    () => {
      host.activeTab = 'learners';
      host.render();
    },
    'button primary',
    'users',
  );
  spotHead.append(spotCopy, openDirectoryBtn);
  accessSpotlight.append(spotHead);

  const previewUsers = host.users.filter(u => !isSyntheticEmail(u.email)).slice(0, 6);
  if (previewUsers.length > 0) {
    const quickGrid = el('div', 'admin-student-quick-grid');
    const totalCatalog = host.catalogCourses.length || s.courses || 29;
    for (const u of previewUsers) {
      const card = el('div', 'admin-student-quick-card');
      const top = el('div', 'quick-student-top');
      const avatar = el(
        'div',
        `admin-user-avatar${u.role === 'admin' ? ' is-admin' : ''}`,
        initialsOf(u.name, u.email),
      );
      const info = el('div', 'quick-student-info');
      info.append(el('strong', '', u.name || 'Student'), el('span', 'muted', u.email));
      const roleBadge = el('span', `badge-${u.role}`, u.role.toUpperCase());
      top.append(avatar, info, roleBadge);

      const enrolledCount = u.role === 'admin' ? totalCatalog : (u.enrollments ?? 0);
      const pct = Math.min(100, Math.round((enrolledCount / Math.max(1, totalCatalog)) * 100));
      const accessBarWrap = el('div', 'quick-student-access');
      const accessLabels = el('div', 'quick-student-access-labels');
      accessLabels.append(
        el('span', '', u.role === 'admin' ? 'Full Admin Access' : 'Course Access Granted'),
        el('strong', '', `${enrolledCount} / ${totalCatalog} Courses`),
      );
      const barTrack = el('div', 'admin-access-progress-track');
      const barFill = el('div', 'admin-access-progress-fill');
      barFill.style.width = `${pct}%`;
      barTrack.append(barFill);
      accessBarWrap.append(accessLabels, barTrack);

      const actions = el('div', 'quick-student-actions');
      const manageBtn = button(
        'Manage Courses & Access',
        () => void host.openStudentAccessModal(u, 'courses'),
        'button primary small-btn',
        'key',
      );
      const secBtn = button(
        'Security',
        () => void host.openStudentAccessModal(u, 'security'),
        'button secondary small-btn',
        'shield',
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
  if (!host.overviewData.recent_activity_sessions.length) {
    recent.append(
      emptyState({
        className: 'admin-empty-state',
        title: 'No activity sessions recorded yet.',
        description: 'Learner playback sessions will appear here.',
      }),
    );
  } else {
    const table = el('table', 'admin-table');
    const thead = el('thead');
    thead.innerHTML = '<tr><th>Student</th><th>Lecture</th><th>Active Time</th><th>Last Heartbeat</th></tr>';
    const tbody = el('tbody');
    for (const row of host.overviewData.recent_activity_sessions.slice(0, 10)) {
      const tr = el('tr');
      const name = escapeHtml(String(row.name || row.email || 'Anonymous'));
      const email = escapeHtml(String(row.email || ''));
      const title = escapeHtml(String(row.title || 'Lesson'));
      const secs = escapeHtml(String(row.activity_seconds || 0));
      const active = escapeHtml(new Date(String(row.last_active || '')).toLocaleTimeString());
      tr.innerHTML = `
        <td><strong>${name}</strong><br><small class="muted">${email}</small></td>
        <td>${title}</td>
        <td>${secs}s</td>
        <td><small class="muted">${active}</small></td>
      `;
      tbody.append(tr);
    }
    table.append(thead, tbody);
    recent.append(table);
  }
  wrap.append(recent);

  return wrap;
}
