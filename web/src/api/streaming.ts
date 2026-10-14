import type { HistoryItem } from '../contracts';
import { parseContinued, parseSaved } from '../discovery/contracts';
import type { HttpClient } from './http';

export function history(
  client: HttpClient,
  cursor = '',
  signal?: AbortSignal,
): Promise<{ history: HistoryItem[]; next_cursor?: string | null }> {
  const query = new URLSearchParams({ limit: '30' });
  if (cursor) query.set('cursor', cursor);
  return client.request(`/streaming/history?${query}`, signal ? { signal } : {});
}

export function clearHistory(client: HttpClient, signal?: AbortSignal): Promise<void> {
  return client.request('/streaming/history/clear', { method: 'POST', body: {}, ...(signal ? { signal } : {}) });
}

export function savedItems(client: HttpClient, cursor = '', signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: '24' });
  if (cursor) query.set('cursor', cursor);
  return client.request(`/streaming/my-list?${query}`, signal ? { signal } : {}).then(parseSaved);
}

export function continueLearning(client: HttpClient, signal?: AbortSignal) {
  return client.request('/streaming/continue-watching', signal ? { signal } : {}).then(parseContinued);
}

export function saveCourse(client: HttpClient, id: string, signal?: AbortSignal): Promise<void> {
  return client.request('/streaming/my-list', {
    method: 'POST',
    body: { item_type: 'course', item_id: id },
    ...(signal ? { signal } : {}),
  });
}

export function removeSaved(
  client: HttpClient,
  type: 'course' | 'lecture',
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  return client.request(`/streaming/my-list/${type}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...(signal ? { signal } : {}),
  });
}
