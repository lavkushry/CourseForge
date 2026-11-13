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

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid labs catalog response');
  }
  return value as Record<string, unknown>;
}

export function parseLabsCatalog(value: unknown): LabsCatalog {
  const data = object(value);
  if (!Array.isArray(data.labs)) throw new Error('Invalid labs list');
  const labs: LabDefinition[] = data.labs.map(raw => {
    const item = object(raw);
    if (typeof item.slug !== 'string' || !item.slug) throw new Error('Invalid lab slug');
    if (typeof item.title !== 'string' || !item.title) throw new Error('Invalid lab title');
    const lab: LabDefinition = {
      slug: item.slug,
      title: item.title,
      type: typeof item.type === 'string' ? item.type : 'unknown',
      objective: typeof item.objective === 'string' ? item.objective : '',
      filename: typeof item.filename === 'string' ? item.filename : 'solution',
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

export function labsCatalog(client: HttpClient, signal?: AbortSignal): Promise<LabsCatalog> {
  return client.request('/labs', signal ? { signal } : {}).then(parseLabsCatalog);
}
