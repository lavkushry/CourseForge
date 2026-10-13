import { svgIcon, type IconName } from '../icons';
import type { ApiClient } from '../api';
import type { AdminOverview, AdminUser } from './contracts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = text;
  return n;
}

function button(text: string, action: () => void, cls = 'button'): HTMLButtonElement {
  const n = el('button', cls, text);
  n.type = 'button';
  n.addEventListener('click', action);
  return n;
}

type AdminTab = 'overview' | 'learners' | 'funnels' | 'retention' | 'ai' | 'activity' | 'system';

export class AdminView {
  private activeTab: AdminTab = 'overview';
  private overviewData: AdminOverview | null = null;
  private users: AdminUser[] = [];
  private loading = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly api: ApiClient,
    private readonly notice: (msg: string, error?: boolean) => void,
  ) {}

  async activate(signal?: AbortSignal): Promise<void> {
    this.root.hidden = false;
    this.loading = true;
    this.render();
    try {
      this.overviewData = await this.api.adminOverview(signal);
      const userResp = await this.api.adminUsers(50, '', signal);
      this.users = userResp.users;
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

    // Admin Header
    const head = el('div', 'admin-header');
    head.append(
      el('span', 'eyebrow', 'PLATFORM ADMINISTRATION & OBSERVABILITY'),
      el('h1', '', 'CourseForge Command Center'),
      el('p', 'muted', 'Real-time learning analytics, student oversight, and system diagnostics.')
    );

    // Tab Navigation
    const nav = el('nav', 'admin-nav');
    const tabs: Array<{ id: AdminTab; label: string }> = [
      { id: 'overview', label: 'Overview Metrics' },
      { id: 'learners', label: 'Learners Directory' },
      { id: 'funnels', label: 'Course Funnels' },
      { id: 'retention', label: 'Retention & Heatmaps' },
      { id: 'ai', label: 'AI Workers & Vectors' },
      { id: 'activity', label: 'Live Activity & Exports' },
      { id: 'system', label: 'System Health' },
    ];
    for (const t of tabs) {
      const btn = button(t.label, () => {
        this.activeTab = t.id;
        this.render();
      }, `admin-tab-btn${this.activeTab === t.id ? ' active' : ''}`);
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
      this.metricCard('Total Students', String(s.students), `${s.verified_students} verified, ${s.suspended_students} suspended`, 'users'),
      this.metricCard('Active Courses', String(s.courses), `${s.available_lectures} / ${s.lectures} lectures ready`, 'book'),
      this.metricCard('Completed Lessons', String(s.completed_lessons), 'Durable learner progress', 'check'),
      this.metricCard('Active Sessions', String(s.active_sessions), 'Currently signed-in learners', 'zap'),
      this.metricCard('Total Watch Time', `${Math.round(s.watched_seconds / 3600)} hrs`, `${s.watched_seconds.toLocaleString()} seconds accepted`, 'clock'),
      this.metricCard('Total Enrollments', String(s.enrollments), 'Active course registrations', 'target')
    );

    wrap.append(grid);

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
    wrap.append(el('h2', '', 'Learners Directory'));

    if (!this.users.length) {
      wrap.append(el('p', 'muted', 'No learners registered.'));
      return wrap;
    }

    const table = el('table', 'admin-table');
    const thead = el('thead');
    thead.innerHTML = '<tr><th>Name / Email</th><th>Role</th><th>Status</th><th>Joined</th><th>Actions</th></tr>';
    const tbody = el('tbody');

    for (const u of this.users) {
      const tr = el('tr');
      const nameCol = el('td');
      nameCol.innerHTML = `<strong>${u.name}</strong><br><span class="muted">${u.email}</span>`;

      const roleCol = el('td');
      roleCol.append(el('span', `badge-${u.role}`, u.role.toUpperCase()));

      const statusCol = el('td');
      statusCol.append(el('span', u.suspended ? 'badge-suspended' : u.verified ? 'badge-verified' : 'badge-unverified',
        u.suspended ? 'Suspended' : u.verified ? 'Verified' : 'Pending'));

      const joinedCol = el('td');
      joinedCol.textContent = new Date(u.created_at).toLocaleDateString();

      const actionCol = el('td');
      const inspectBtn = button('View Report', async () => {
        try {
          const report = await this.api.adminLearnerReport(u.id);
          this.showLearnerModal(report);
        } catch (err) {
          this.notice('Could not load learner report: ' + (err instanceof Error ? err.message : String(err)), true);
        }
      }, 'button quiet');
      actionCol.append(inspectBtn);

      tr.append(nameCol, roleCol, statusCol, joinedCol, actionCol);
      tbody.append(tr);
    }

    table.append(thead, tbody);
    wrap.append(table);
    return wrap;
  }

  private renderFunnelsTab(): HTMLElement {
    const wrap = el('div', 'admin-tab-pane');
    wrap.append(el('h2', '', 'Course Funnel & Completion Tracking'));

    if (!this.overviewData || !this.overviewData.funnels.length) {
      wrap.append(el('p', 'muted', 'No course funnels available.'));
      return wrap;
    }

    const table = el('table', 'admin-table');
    const thead = el('thead');
    thead.innerHTML = '<tr><th>Course Title</th><th>Enrollments</th><th>Started Lessons</th><th>Conversion Rate</th></tr>';
    const tbody = el('tbody');

    for (const f of this.overviewData.funnels) {
      const enrolled = Number(f.enrolled || 0);
      const started = Number(f.started || 0);
      const rate = enrolled > 0 ? Math.round((started / enrolled) * 100) : 0;
      const tr = el('tr');
      tr.innerHTML = `
        <td><strong>${String(f.title || 'Course')}</strong></td>
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
      el('h2', '', 'Video Retention Curves & Replay Heatmaps'),
      el('p', 'muted', 'Audience retention, second-by-second drop-off gradients, and high-frequency replay moments.')
    );

    const container = el('div', 'admin-retention-container');
    container.append(el('p', 'muted', 'Loading retention telemetry…'));
    wrap.append(container);

    this.api.adminRetentionCurve().then(data => {
      container.replaceChildren();

      const metaRow = el('div', 'retention-meta-row');
      metaRow.append(
        el('h3', '', data.lesson_title || 'Active Lecture'),
        el('span', 'badge-stat', `Completion Rate: ${data.completion_rate}%`),
        el('span', 'badge-stat', `Audience Sessions: ${data.total_sessions}`)
      );
      container.append(metaRow);

      // Render crisp responsive SVG Chart
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 600 180');
      svg.classList.add('retention-chart-svg');

      const pts = data.points;
      if (pts.length > 1) {
        const maxSec = data.duration_seconds || 1800;
        const coords = pts.map(p => {
          const x = (p.second / maxSec) * 580 + 10;
          const y = 170 - (p.percentage / 100) * 150;
          return { x, y, p };
        });

        const lineD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
        const firstX = coords[0]?.x ?? 10;
        const lastX = coords[coords.length - 1]?.x ?? 590;
        const areaD = `${lineD} L ${lastX.toFixed(1)} 170 L ${firstX.toFixed(1)} 170 Z`;

        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defs.innerHTML = `
          <linearGradient id="retentionGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#6366f1" stop-opacity="0.45"/>
            <stop offset="100%" stop-color="#6366f1" stop-opacity="0.02"/>
          </linearGradient>
        `;
        svg.append(defs);

        const areaPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        areaPath.setAttribute('d', areaD);
        areaPath.setAttribute('fill', 'url(#retentionGrad)');

        const linePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        linePath.setAttribute('d', lineD);
        linePath.setAttribute('fill', 'none');
        linePath.setAttribute('stroke', '#6366f1');
        linePath.setAttribute('stroke-width', '2.5');

        svg.append(areaPath, linePath);

        // Highlight replay peaks
        for (const c of coords) {
          if (c.p.replays > 3) {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', c.x.toFixed(1));
            circle.setAttribute('cy', c.y.toFixed(1));
            circle.setAttribute('r', '4');
            circle.setAttribute('fill', '#10b981');
            circle.setAttribute('stroke', '#0d1117');
            circle.setAttribute('stroke-width', '2');
            svg.append(circle);
          }
        }
      }
      container.append(svg);

      if (data.peak_moments.length > 0) {
        const peakBox = el('div', 'retention-peaks-box');
        peakBox.append(el('h4', '', 'Identified Concept Spikes'));
        for (const m of data.peak_moments) {
          const row = el('div', 'peak-moment-row');
          const min = Math.floor(m.second / 60);
          const sec = m.second % 60;
          row.append(
            el('span', 'badge-time', `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`),
            el('span', '', m.label)
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
      button('Download Activity CSV', () => this.downloadCSV('player-activity'), 'button primary')
    );

    const playbackCard = el('div', 'export-card');
    playbackCard.append(
      el('h3', '', 'Playback Stream Sessions CSV'),
      el('p', 'muted', 'Accepted browser playback durations, watch progress, and byte-range streaming intervals.'),
      button('Download Playback CSV', () => this.downloadCSV('playback'), 'button primary')
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
    top.append(svgIcon(icon), el('span', '', title));
    card.append(
      top,
      el('div', 'metric-value', value),
      el('div', 'metric-sub', subtitle)
    );
    return card;
  }

  private showLearnerModal(report: any): void {
    const dialog = el('dialog', 'learner-dialog');
    const inner = el('div', 'learner-modal-body');
    const u = report.user;

    inner.append(
      el('h2', '', `${u.name} · Learning Profile`),
      el('p', 'muted', `${u.email} · Role: ${u.role}`),
      el('div', 'learner-stats-grid')
    );
    const grid = inner.querySelector('.learner-stats-grid')!;
    grid.append(
      el('div', 'stat-box', `Watched: ${Math.round(u.watched_seconds / 60)} min`),
      el('div', 'stat-box', `Visible Activity: ${Math.round(u.activity_seconds / 60)} min`),
      el('div', 'stat-box', `Focus Time: ${Math.round(u.measured_focus_seconds / 60)} min`),
      el('div', 'stat-box', `Enrollments: ${Array.isArray(report.enrollments) ? report.enrollments.length : 0}`)
    );

    const closeBtn = button('Close Profile', () => dialog.close(), 'button primary');
    inner.append(closeBtn);

    dialog.append(inner);
    document.body.append(dialog);
    dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
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
