import type { AdminHost } from './host';
import { button, el } from './helpers';


export function renderFunnelsTab(host: AdminHost): HTMLElement {
  const wrap = el('div', 'admin-tab-pane');
  wrap.append(el('h2', '', 'Course Conversion Funnels'));

  if (!host.overviewData || !host.overviewData.funnels.length) {
    wrap.append(el('p', 'muted', 'No course funnel metrics recorded yet.'));
    return wrap;
  }

  const table = el('table', 'admin-table');
  const thead = el('thead');
  thead.innerHTML = '<tr><th>Course Title</th><th>Course ID</th><th>Enrolled</th><th>Started</th><th>Conversion</th></tr>';
  const tbody = el('tbody');

  for (const f of host.overviewData.funnels) {
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

export function renderRetentionTab(host: AdminHost): HTMLElement {
  const wrap = el('div', 'admin-tab-pane');
  wrap.append(
    el('h2', '', 'Second-by-Second Video Retention & Replay Heatmap'),
    el('p', 'muted', 'Identify exact lecture timestamps where students drop off or replay complex concepts.')
  );

  const container = el('div', 'retention-container');
  container.append(el('p', 'muted', 'Loading retention telemetry…'));
  wrap.append(container);

  host.api.adminRetentionCurve().then(data => {
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

export function renderActivityTab(host: AdminHost): HTMLElement {
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
    button('Download Activity CSV', () => void host.downloadCSV('player-activity'), 'button primary', 'file')
  );

  const playbackCard = el('div', 'export-card');
  playbackCard.append(
    el('h3', '', 'Playback Stream Sessions CSV'),
    el('p', 'muted', 'Accepted browser playback durations, watch progress, and byte-range streaming intervals.'),
    button('Download Playback CSV', () => void host.downloadCSV('playback'), 'button primary', 'file')
  );

  exportGrid.append(activityCard, playbackCard);
  wrap.append(exportGrid);
  return wrap;
}
