import type { Note } from '../contracts';
import { parseNote, parseNotes } from '../validation';
import type { HttpClient } from './http';

export function notes(
  client: HttpClient,
  id: string,
  cursor = '',
  signal?: AbortSignal,
): Promise<{ notes: Note[]; next_cursor?: string | null }> {
  const query = new URLSearchParams({ limit: '30' });
  if (cursor) query.set('cursor', cursor);
  return client.request(`/lessons/${encodeURIComponent(id)}/notes?${query}`, signal ? { signal } : {}).then(parseNotes);
}

export function createNote(
  client: HttpClient,
  id: string,
  position: number,
  content: string,
  key: string,
  signal?: AbortSignal,
): Promise<Note> {
  return client
    .request(`/lessons/${encodeURIComponent(id)}/notes`, {
      method: 'POST',
      body: { position, content },
      idempotencyKey: key,
      ...(signal ? { signal } : {}),
    })
    .then(parseNote);
}

export function deleteNote(client: HttpClient, lessonId: string, noteId: string, signal?: AbortSignal): Promise<void> {
  return client.request(`/lessons/${encodeURIComponent(lessonId)}/notes/${encodeURIComponent(noteId)}`, {
    method: 'DELETE',
    ...(signal ? { signal } : {}),
  });
}
