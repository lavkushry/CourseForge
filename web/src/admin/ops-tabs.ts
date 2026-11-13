import { emptyState } from '../components';
import {
  aiOfflineBanner,
  aiStatusLabel,
  companionUnavailableCopy,
  indexScanUnavailableCopy,
  type AiDependencyStatus,
} from '../ai/status';
import {
  jobCanCancel,
  jobCanRetry,
  jobEmptyCopy,
  jobLoadFailureCopy,
  jobProgressLabel,
  jobRetryBlockedCopy,
  type PublicJob,
} from '../jobs/status';
import type { AdminHost } from './host';
import {
  adminAiOfflineLabel,
  adminCourseMappingRows,
  adminSystemUnavailableList,
  adminTaskCountLabel,
} from './status';
import { button, el } from './helpers';

export function renderAuditTab(host: AdminHost): HTMLElement {
  const wrap = el('div', 'admin-tab-pane');
  wrap.append(
    el('h2', '', 'Administrative Audit & Security Event Log'),
    el(
      'p',
      'muted',
      'Immutable record of student course access grants, revocations, account invitations, role changes, and session revocations.',
    ),
  );

  const container = el('div', 'admin-section');
  container.append(el('p', 'muted', 'Loading administrative audit trail…'));
  wrap.append(container);

  Promise.all([host.api.adminAuditLog(50), host.api.adminAccessEvents('', 25)])
    .then(([auditResp, accessResp]) => {
      container.replaceChildren();
      container.append(el('h3', '', `Recent Administrator Actions (${auditResp.items.length})`));
      if (!auditResp.items.length) {
        container.append(
          emptyState({
            className: 'admin-empty-state',
            title: 'No administrative actions logged yet.',
            description: 'Grants, role changes, and invitations will appear here when recorded.',
          }),
        );
      } else {
        const tbl = el('table', 'admin-table');
        tbl.innerHTML =
          '<thead><tr><th>Administrator</th><th>Action</th><th>Target Resource (User / Course)</th><th>Timestamp</th></tr></thead>';
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
      if (!accessResp.items.length) {
        accBox.append(el('p', 'muted', 'No access events recorded yet.'));
      } else {
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
    })
    .catch(err => {
      container.replaceChildren(
        emptyState({
          className: 'admin-empty-state',
          title: 'Could not load audit trail',
          description: err instanceof Error ? err.message : String(err),
        }),
      );
    });

  return wrap;
}

export function renderAiTab(host: AdminHost): HTMLElement {
  const wrap = el('div', 'admin-tab-pane');
  wrap.append(
    el('h2', '', 'AI Learning Engine & Vector Health'),
    el(
      'p',
      'muted',
      'Measured Ollama, pgvector, and Qdrant status only. Companion, index, and scan stay disabled when dependencies are offline — success and latency are never invented.',
    ),
  );

  const stats = el('div', 'admin-metrics-grid');
  wrap.append(stats);

  const adapterBox = el('div', 'admin-section');
  wrap.append(adapterBox);

  const mappingSection = el('div', 'admin-section');
  mappingSection.append(
    el('h3', '', 'Course mapping (measured)'),
    el(
      'p',
      'muted',
      'Lesson and provider-claim counts from /admin/system. Empty means no measured rows — not a fabricated catalog.',
    ),
  );
  const mappingBody = el('div', '');
  mappingBody.append(el('p', 'muted', 'Loading measured course mapping…'));
  mappingSection.append(mappingBody);
  wrap.append(mappingSection);

  void Promise.all([
    host.api.aiStatus(),
    host.systemReport
      ? Promise.resolve(host.systemReport)
      : host.api.adminSystem().then(report => {
          host.systemReport = report;
          return report;
        }),
  ])
    .then(([st, system]) => {
      host.aiStatus = st;
      renderAiStats(host, stats, st);
      renderAiAdapters(adapterBox, st);
      renderMappingTable(mappingBody, system.courses, system.courses_truncated, system.course_count);
    })
    .catch(err => {
      stats.replaceChildren(
        emptyState({
          className: 'admin-empty-state',
          title: 'Could not load AI engine status',
          description: err instanceof Error ? err.message : String(err),
        }),
      );
      adapterBox.replaceChildren();
      mappingBody.replaceChildren(
        el('p', 'muted', 'Course mapping unavailable until AI/system status loads.'),
      );
    });

  return wrap;
}

function renderAiStats(host: AdminHost, stats: HTMLElement, st: AiDependencyStatus): void {
  const ollamaLabel = adminAiOfflineLabel(st.ollama_online, st.pgvector_active);
  const qdrantLabel = !st.qdrant_configured
    ? 'Not configured'
    : st.qdrant_online
      ? 'Online'
      : 'Offline';
  stats.replaceChildren(
    host.metricCard(
      'pgvector',
      st.pgvector_active ? 'Active' : 'Inactive',
      st.pgvector_active
        ? `${st.vector_dimensions || 0}-dim embeddings table`
        : 'Extension not installed — not invented active',
      'database',
    ),
    host.metricCard(
      'Indexed Vectors',
      String(st.embeddings_count ?? 0),
      'Rows in lesson_embeddings',
      'check-circle',
    ),
    host.metricCard(
      'Transcript Chunks',
      String(st.transcript_chunks),
      'Timestamped lecture segments',
      'file',
    ),
    host.metricCard(
      'Ollama Service',
      ollamaLabel,
      st.ollama_chat_model || 'No chat model reported',
      'sparkle',
    ),
    host.metricCard(
      'Embedding Model',
      st.ollama_embedding_model || '—',
      st.ollama_online ? 'Reported by AI status' : 'Offline — not used',
      'zap',
    ),
    host.metricCard('Qdrant', qdrantLabel, 'Knowledge retrieval dependency', 'target'),
  );
}

function renderAiAdapters(box: HTMLElement, st: AiDependencyStatus): void {
  box.replaceChildren();
  box.append(el('h3', '', 'Companion / index / scan adapters'));
  const banner = aiOfflineBanner(st);
  if (banner) {
    box.append(el('p', 'muted', banner));
  } else {
    box.append(el('p', 'muted', aiStatusLabel(st)));
  }
  const companion = companionUnavailableCopy(st);
  const indexScan = indexScanUnavailableCopy(st);
  if (banner) {
    box.append(
      el('p', '', `${companion.title}: ${companion.description}`),
      el('p', '', `${indexScan.title}: ${indexScan.description}`),
    );
  } else {
    box.append(
      el(
        'p',
        'muted',
        'Dependencies report online. Job progress still comes only from durable job APIs — this panel does not invent completion.',
      ),
    );
  }
}

function renderMappingTable(
  body: HTMLElement,
  courses: Array<Record<string, unknown>> | undefined,
  truncated: boolean,
  courseCount: number,
): void {
  body.replaceChildren();
  const rows = adminCourseMappingRows(courses);
  if (!rows.length) {
    body.append(
      emptyState({
        className: 'admin-empty-state',
        title: 'No measured course mapping rows',
        description: 'Mapping percentages and chunk totals are not fabricated when the system report is empty.',
      }),
    );
    return;
  }
  const table = el('table', 'admin-table');
  table.innerHTML = `
    <thead>
      <tr>
        <th>Course ID</th>
        <th>Published</th>
        <th>Lessons</th>
        <th>Provider Claims</th>
        <th>Measured Durations</th>
      </tr>
    </thead>
  `;
  const tbody = el('tbody');
  for (const row of rows.slice(0, 25)) {
    const tr = el('tr');
    tr.innerHTML = `
      <td><code>${row.course_id}</code></td>
      <td>${row.published ? 'Yes' : 'No'}</td>
      <td>${row.lessons}</td>
      <td>${row.mapped}</td>
      <td>${row.measured_durations}</td>
    `;
    tbody.append(tr);
  }
  table.append(tbody);
  body.append(table);
  if (truncated) {
    body.append(el('p', 'muted', `Showing first ${rows.length} of ${courseCount} courses (truncated).`));
  }
}

export function renderSystemTab(host: AdminHost): HTMLElement {
  const wrap = el('div', 'admin-tab-pane');
  wrap.append(
    el('h2', '', 'System Diagnostics & Job Queue'),
    el(
      'p',
      'muted',
      'SQL-backed system facts from /admin/system plus owned durable jobs. External service checks listed as unavailable are not invented healthy.',
    ),
  );

  const stats = el('div', 'admin-metrics-grid');
  wrap.append(stats);

  const unavailableBox = el('div', 'admin-section');
  wrap.append(unavailableBox);

  const jobsSection = el('div', 'admin-section');
  jobsSection.append(
    el('h3', '', 'Owned jobs'),
    el(
      'p',
      'muted',
      'Progress, cancel, and index/transcribe/export retry against /api/v1/jobs. Completion is never faked.',
    ),
  );
  const jobsBody = el('div', 'admin-jobs-body');
  jobsBody.append(el('p', 'muted', 'Loading jobs…'));
  jobsSection.append(jobsBody);
  wrap.append(jobsSection);

  const loadSystem = () =>
    (host.systemReport
      ? Promise.resolve(host.systemReport)
      : host.api.adminSystem().then(report => {
          host.systemReport = report;
          return report;
        })
    )
      .then(report => {
        const caps = report.capabilities || {};
        const reg = caps.registration_mode || 'unknown';
        const email =
          caps.email_configured === true
            ? 'Configured'
            : caps.email_configured === false
              ? 'Not configured'
              : 'Unknown';
        const provider =
          caps.provider_configured === true
            ? 'Configured'
            : caps.provider_configured === false
              ? 'Not configured'
              : 'Unknown';
        stats.replaceChildren(
          host.metricCard('Courses', String(report.course_count), adminTaskCountLabel(report.tasks), 'book'),
          host.metricCard(
            'Pending invitations',
            String(report.pending_invitations),
            `Registration mode: ${reg}`,
            'users',
          ),
          host.metricCard('Email capability', email, 'From administrator capabilities — not invented', 'send'),
          host.metricCard(
            'Provider capability',
            provider,
            `Server now: ${report.server_now || '—'}`,
            'zap',
          ),
        );
        const unavailable = adminSystemUnavailableList(report);
        unavailableBox.replaceChildren(
          el('h3', '', 'Explicitly unavailable in this module'),
          el(
            'p',
            'muted',
            unavailable.length
              ? unavailable.join(', ')
              : 'No unavailable markers returned.',
          ),
          el(
            'p',
            'muted',
            `Retention scheduler: ${String(report.retention?.scheduler_status || 'unknown')}`,
          ),
        );
      })
      .catch(err => {
        stats.replaceChildren(
          emptyState({
            className: 'admin-empty-state',
            title: 'Could not load system report',
            description: err instanceof Error ? err.message : String(err),
          }),
        );
        unavailableBox.replaceChildren();
      });

  const loadJobs = () =>
    host.api
      .listJobs(50)
      .then(resp => {
        host.jobs = resp.jobs;
        host.jobsError = null;
        renderJobsBody(host, jobsBody, () => {
          void loadJobs();
        });
      })
      .catch(err => {
        host.jobs = [];
        host.jobsError = err instanceof Error ? err.message : String(err);
        const copy = jobLoadFailureCopy(host.jobsError);
        jobsBody.replaceChildren(
          emptyState({
            className: 'admin-empty-state',
            title: copy.title,
            description: copy.description,
          }),
        );
      });

  void loadSystem();
  void loadJobs();
  return wrap;
}

function renderJobsBody(host: AdminHost, body: HTMLElement, refresh: () => void): void {
  body.replaceChildren();
  const jobs = host.jobs || [];
  if (!jobs.length) {
    const copy = jobEmptyCopy();
    body.append(
      emptyState({
        className: 'admin-empty-state',
        title: copy.title,
        description: copy.description,
      }),
    );
    body.append(
      button('Refresh jobs', () => refresh(), 'button secondary small-btn', 'refresh'),
    );
    return;
  }

  const table = el('table', 'admin-table');
  table.innerHTML =
    '<thead><tr><th>Job</th><th>Kind / Lesson</th><th>Status</th><th>Actions</th></tr></thead>';
  const tbody = el('tbody');
  for (const job of jobs) {
    tbody.append(renderJobRow(host, job, refresh));
  }
  table.append(tbody);
  body.append(table);
  body.append(button('Refresh jobs', () => refresh(), 'button secondary small-btn', 'refresh'));
}

function renderJobRow(host: AdminHost, job: PublicJob, refresh: () => void): HTMLElement {
  const tr = el('tr');
  const idCell = el('td');
  idCell.append(el('code', '', job.id));
  const kindCell = el('td');
  kindCell.append(
    el('strong', '', job.kind),
    el('br', ''),
    el('small', 'muted', job.lesson_id),
  );
  const statusCell = el('td', '', jobProgressLabel(job));
  const actions = el('td');
  const group = el('div', 'admin-row-actions');

  if (jobCanCancel(job.state)) {
    group.append(
      button(
        'Cancel',
        () => {
          void host.api
            .cancelJob(job.id)
            .then(() => {
              host.notice(`Canceled job ${job.id}`);
              refresh();
            })
            .catch(err => {
              host.notice(
                'Cancel failed: ' + (err instanceof Error ? err.message : String(err)),
                true,
              );
            });
        },
        'button secondary small-btn',
        'ban',
      ),
    );
  }

  if (job.state === 'failed' || job.state === 'canceled') {
    if (jobCanRetry(job)) {
      group.append(
        button(
          'Retry',
          () => {
            const key = `retry-${job.id}-${Date.now()}`;
            void host.api
              .submitJob({ kind: job.kind, lesson_id: job.lesson_id, payload: { version: 1 } }, key)
              .then(created => {
                host.notice(`Retried as ${created.id} (${created.state})`);
                refresh();
              })
              .catch(err => {
                host.notice(
                  'Retry failed: ' + (err instanceof Error ? err.message : String(err)),
                  true,
                );
              });
          },
          'button primary small-btn',
          'refresh',
        ),
      );
    } else {
      group.append(el('small', 'muted', jobRetryBlockedCopy(job.kind)));
    }
  }

  if (!group.childElementCount) {
    group.append(el('small', 'muted', '—'));
  }
  actions.append(group);
  tr.append(idCell, kindCell, statusCell, actions);
  return tr;
}
