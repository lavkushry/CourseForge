import type { Course, Lesson } from '../contracts';
import { ContractError, parseCourse, parseLesson } from '../validation';

export interface SavedItem { id: string; item_type: 'course' | 'lecture'; course_id: string; title: string }
export interface ContinueItem extends Lesson { position: number; percent: number; completed: boolean }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('discovery response');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new ContractError('saved item');
  return value;
}
export function parseSaved(value: unknown): { items: SavedItem[]; next_cursor: string | null } {
  const data = object(value);
  if (!Array.isArray(data.items) || data.items.length > 100) throw new ContractError('saved list');
  return { items: data.items.map(raw => {
    const item = object(raw);
    if (item.item_type !== 'course' && item.item_type !== 'lecture') throw new ContractError('saved item type');
    return { id: text(item.id), item_type: item.item_type, course_id: text(item.course_id), title: text(item.title) };
  }), next_cursor: typeof data.next_cursor === 'string' && data.next_cursor ? data.next_cursor : null };
}
export function parseContinued(value: unknown): ContinueItem[] {
  const data = object(value);
  if (!Array.isArray(data.items) || data.items.length > 15) throw new ContractError('continue learning');
  return data.items.map(raw => {
    const item = object(raw);
    if (typeof item.position !== 'number' || !Number.isFinite(item.position) || item.position < 0 || typeof item.percent !== 'number' || !Number.isFinite(item.percent) || item.percent < 0 || item.percent > 100 || typeof item.completed !== 'boolean') throw new ContractError('learning progress');
    return { ...parseLesson(item), position: item.position, percent: item.percent, completed: item.completed };
  });
}
export function courseCover(course: Course): string | null {
  if (!course.cover_url) return null;
  try {
    const url = new URL(course.cover_url, 'https://courseforge.invalid');
    return url.origin === 'https://courseforge.invalid' && url.pathname.startsWith('/api/v1/courses/') && url.pathname.endsWith('/cover') ? `${url.pathname}${url.search}` : null;
  } catch { return null; }
}
