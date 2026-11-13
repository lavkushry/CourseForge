import type { HistoryItem } from '../contracts';
import { ContractError } from '../validation';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('history response');
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new ContractError(label);
  return value;
}

function finiteNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ContractError(label);
  }
  return value;
}

/** Strict parser for GET /streaming/history — never invents resume positions. */
export function parseHistory(value: unknown): { history: HistoryItem[]; next_cursor: string | null } {
  const data = object(value);
  const rawItems = Array.isArray(data.history)
    ? data.history
    : Array.isArray(data.items)
      ? data.items
      : null;
  if (!rawItems || rawItems.length > 100) throw new ContractError('history list');
  const history = rawItems.map(raw => {
    const item = object(raw);
    const watchedAt = item.watched_at;
    if (typeof watchedAt !== 'string' || !watchedAt || Number.isNaN(Date.parse(watchedAt))) {
      throw new ContractError('history watched_at');
    }
    return {
      id: text(item.id, 'history lesson ID', 512),
      course_id: text(item.course_id, 'history course ID', 512),
      title: text(item.title, 'history title'),
      sort_order: finiteNumber(item.sort_order, 'history sort_order', 0, 1e9),
      duration_seconds: finiteNumber(item.duration_seconds, 'history duration', 0, 1e9),
      section_title: typeof item.section_title === 'string' ? item.section_title : '',
      flow_order: finiteNumber(item.flow_order, 'history flow_order', 0, 1e9),
      position: finiteNumber(item.position, 'history position', 0, 1e9),
      percent: finiteNumber(item.percent, 'history percent', 0, 100),
      completed: item.completed === true,
      watched_at: watchedAt,
    };
  });
  return {
    history,
    next_cursor: typeof data.next_cursor === 'string' && data.next_cursor ? data.next_cursor : null,
  };
}
