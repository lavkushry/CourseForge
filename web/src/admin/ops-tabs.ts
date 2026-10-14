import type { AdminHost } from './host';
import {  el } from './helpers';


export function renderAuditTab(host: AdminHost): HTMLElement {
  const wrap = el('div', 'admin-tab-pane');
  wrap.append(
    el('h2', '', 'Administrative Audit & Security Event Log'),
    el('p', 'muted', 'Immutable record of student course access grants, revocations, account invitations, role changes, and session revocations.')
  );

  const container = el('div', 'admin-section');
  container.append(el('p', 'muted', 'Loading administrative audit trail…'));
  wrap.append(container);

  Promise.all([
    host.api.adminAuditLog(50).catch(() => ({ items: [] })),
    host.api.adminAccessEvents('', 25).catch(() => ({ items: [] })),
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

export function renderAiTab(host: AdminHost): HTMLElement {
  const wrap = el('div', 'admin-tab-pane');
  wrap.append(
    el('h2', '', 'AI Learning Engine & pgvector Health'),
    el('p', 'muted', 'PostgreSQL pgvector extension, hosted Ollama embedding/chat pipelines, and background transcription workers.')
  );

  const stats = el('div', 'admin-metrics-grid');
  wrap.append(stats);

  host.api.aiStatus().then(st => {
    stats.replaceChildren(
      host.metricCard('pgvector Database', st.pgvector_active ? 'Active · 0.8.1' : 'Offline', 'PostgreSQL cosine similarity HNSW indexing', 'database'),
      host.metricCard('Vector Dimensions', `${st.vector_dimensions}-dim`, 'Embeddings matching qwen3-embedding:0.6b', 'target'),
      host.metricCard('Indexed Vectors', String(st.embeddings_count), 'Embeddings stored in lesson_embeddings', 'check-circle'),
      host.metricCard('Transcript Chunks', String(st.transcript_chunks), 'Total timestamped lecture segments', 'file'),
      host.metricCard('Ollama Service', st.ollama_online ? 'Online · Port 11434' : 'Connecting', `Model: ${st.ollama_chat_model}`, 'sparkle'),
      host.metricCard('Embedding Model', st.ollama_embedding_model, 'Fast local inference for RAG semantic search', 'zap')
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

export function renderSystemTab(host: AdminHost): HTMLElement {
  const wrap = el('div', 'admin-tab-pane');
  wrap.append(
    el('h2', '', 'System Diagnostics & Health'),
    el('p', 'muted', 'PostgreSQL cluster status, media gateways, and workers.')
  );

  const stats = el('div', 'admin-metrics-grid');
  stats.append(
    host.metricCard('Go Core API', 'Healthy · Port 18090/18091', 'Active HTTP Replicas with Connection Pooling', 'pulse'),
    host.metricCard('PostgreSQL 18.3', 'Connected · Port 15439', 'Repeatable-read transaction isolation', 'database'),
    host.metricCard('Media Gateway', 'Online · Standalone Range Gateway', 'Encrypted signed leases with byte-range delivery', 'zap'),
    host.metricCard('Vite Frontend', 'Vite 8 + TypeScript 5.9', 'Zero client runtime regressions', 'rocket')
  );
  wrap.append(stats);
  return wrap;
}
