import { ContractError } from '../validation';
import type { HttpClient } from './http';

export interface LabDefinition {
  slug: string;
  title: string;
  type: string;
  objective: string;
  filename: string;
  tip: string;
  category?: string;
  level?: string;
  starter?: string;
}

export interface LabsCatalog {
  labs: LabDefinition[];
  grading_available: boolean;
  kind_available: boolean;
}

export interface LabCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface LabGrade {
  id: string;
  submission_id: string;
  passed: boolean;
  checks: LabCheck[];
  completed_at: string;
}

export interface LabSession {
  session_id: string;
  slug: string;
  filename: string;
  content: string;
  title: string;
  objective: string;
  tip: string;
  type: string;
  category: string;
  level: string;
  status: string;
  revision: number;
  content_hash: string;
  grading_available: boolean;
  result: LabGrade | null;
  created_at: string;
  updated_at: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('labs response');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new ContractError(label);
  return value;
}

export function parseLabsCatalog(value: unknown): LabsCatalog {
  const data = object(value);
  if (!Array.isArray(data.labs)) throw new ContractError('labs list');
  const labs: LabDefinition[] = data.labs.map(raw => {
    const item = object(raw);
    const lab: LabDefinition = {
      slug: text(item.slug, 'lab slug', 512),
      title: text(item.title, 'lab title'),
      type: typeof item.type === 'string' && item.type ? item.type : 'unknown',
      objective: typeof item.objective === 'string' ? item.objective : '',
      filename: typeof item.filename === 'string' && item.filename ? item.filename : 'solution',
      tip: typeof item.tip === 'string' ? item.tip : '',
    };
    if (typeof item.category === 'string' && item.category) lab.category = item.category;
    if (typeof item.level === 'string' && item.level) lab.level = item.level;
    if (typeof item.starter === 'string' && item.starter) lab.starter = item.starter;
    return lab;
  });
  return {
    labs,
    grading_available: data.grading_available === true,
    kind_available: data.kind_available === true,
  };
}

function parseChecks(value: unknown): LabCheck[] {
  if (!Array.isArray(value)) return [];
  const out: LabCheck[] = [];
  for (const raw of value) {
    try {
      const item = object(raw);
      out.push({
        name: text(item.name, 'check name', 512),
        passed: item.passed === true,
        detail: typeof item.detail === 'string' ? item.detail : '',
      });
    } catch {
      /* Skip malformed checks — never invent pass/fail. */
    }
  }
  return out;
}

export function parseLabSession(value: unknown): LabSession {
  const data = object(value);
  let result: LabGrade | null = null;
  if (data.result && typeof data.result === 'object' && !Array.isArray(data.result)) {
    const grade = object(data.result);
    result = {
      id: text(grade.id, 'grade id', 512),
      submission_id: text(grade.submission_id, 'submission id', 512),
      passed: grade.passed === true,
      checks: parseChecks(grade.checks),
      completed_at: typeof grade.completed_at === 'string' ? grade.completed_at : '',
    };
  }
  return {
    session_id: text(data.session_id, 'session id', 512),
    slug: text(data.slug, 'session slug', 512),
    filename: typeof data.filename === 'string' ? data.filename : 'solution',
    content: typeof data.content === 'string' ? data.content : '',
    title: typeof data.title === 'string' ? data.title : '',
    objective: typeof data.objective === 'string' ? data.objective : '',
    tip: typeof data.tip === 'string' ? data.tip : '',
    type: typeof data.type === 'string' ? data.type : 'unknown',
    category: typeof data.category === 'string' ? data.category : 'General',
    level: typeof data.level === 'string' ? data.level : 'Guided',
    status: typeof data.status === 'string' ? data.status : 'started',
    revision:
      typeof data.revision === 'number' && Number.isFinite(data.revision) ? data.revision : 1,
    content_hash: typeof data.content_hash === 'string' ? data.content_hash : '',
    grading_available: data.grading_available === true,
    result,
    created_at: typeof data.created_at === 'string' ? data.created_at : '',
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : '',
  };
}

export function labsCatalog(client: HttpClient, signal?: AbortSignal): Promise<LabsCatalog> {
  return client.request('/labs', signal ? { signal } : {}).then(parseLabsCatalog);
}

export function startLab(
  client: HttpClient,
  slug: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<LabSession> {
  return client
    .request(`/labs/${encodeURIComponent(slug)}/start`, {
      method: 'POST',
      body: {},
      idempotencyKey,
      ...(signal ? { signal } : {}),
    })
    .then(parseLabSession);
}

export function saveLabFile(
  client: HttpClient,
  sessionId: string,
  content: string,
  expectedRevision: number,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<LabSession> {
  return client
    .request(`/lab-sessions/${encodeURIComponent(sessionId)}/file`, {
      method: 'PUT',
      body: { content, expected_revision: expectedRevision },
      idempotencyKey,
      ...(signal ? { signal } : {}),
    })
    .then(parseLabSession);
}

export function submitLab(
  client: HttpClient,
  sessionId: string,
  expectedRevision: number,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<LabSession> {
  return client
    .request(`/lab-sessions/${encodeURIComponent(sessionId)}/submit`, {
      method: 'POST',
      body: { expected_revision: expectedRevision },
      idempotencyKey,
      ...(signal ? { signal } : {}),
    })
    .then(parseLabSession);
}
