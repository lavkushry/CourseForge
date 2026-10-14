import type { Course, Lesson, Progress } from '../contracts';
import { parseCourseDetail, parseCourses, parseLessonDetail, parseProgress } from '../validation';
import type { HttpClient } from './http';

export function courses(
  client: HttpClient,
  cursor = '',
  signal?: AbortSignal,
  search = '',
): Promise<{ courses: Course[]; next_cursor?: string | null }> {
  const query = new URLSearchParams({ limit: '50' });
  if (cursor) query.set('cursor', cursor);
  if (search) query.set('q', search);
  return client.request(`/public/courses?${query}`, signal ? { signal } : {}).then(parseCourses);
}

export function course(
  client: HttpClient,
  id: string,
  signal?: AbortSignal,
  cursor = '',
): Promise<{ course: Course; lessons: Lesson[]; next_cursor?: string | null; resume_lesson_id?: string | null }> {
  const query = new URLSearchParams({ limit: '100' });
  if (cursor) query.set('cursor', cursor);
  return client.request(`/courses/${encodeURIComponent(id)}?${query}`, signal ? { signal } : {}).then(parseCourseDetail);
}

export function publicCourse(
  client: HttpClient,
  id: string,
  signal?: AbortSignal,
  cursor = '',
): Promise<{ course: Course; lessons: Lesson[]; next_cursor?: string | null; resume_lesson_id?: string | null }> {
  const query = new URLSearchParams({ limit: '100' });
  if (cursor) query.set('cursor', cursor);
  return client
    .request(`/public/courses/${encodeURIComponent(id)}?${query}`, signal ? { signal } : {})
    .then(parseCourseDetail);
}

export async function courseAll(
  client: HttpClient,
  id: string,
  signal?: AbortSignal,
  preview = false,
): Promise<{ course: Course; lessons: Lesson[]; resume_lesson_id?: string | null }> {
  const fn = preview ? publicCourse.bind(null, client) : course.bind(null, client);
  let res = await fn(id, signal);
  const courseData = res.course;
  const lessons = [...res.lessons];
  const resume_lesson_id = res.resume_lesson_id ?? null;
  let cursor = res.next_cursor;
  while (cursor && !signal?.aborted) {
    res = await fn(id, signal, cursor);
    lessons.push(...res.lessons);
    cursor = res.next_cursor;
  }
  return { course: courseData, lessons, resume_lesson_id };
}

export function enroll(client: HttpClient, id: string, signal?: AbortSignal): Promise<void> {
  return client.request(`/courses/${encodeURIComponent(id)}/enroll`, {
    method: 'POST',
    body: {},
    ...(signal ? { signal } : {}),
  });
}

export function lesson(
  client: HttpClient,
  id: string,
  signal?: AbortSignal,
): Promise<{ lesson: Lesson; progress: Progress | null }> {
  return client.request(`/lessons/${encodeURIComponent(id)}`, signal ? { signal } : {}).then(parseLessonDetail);
}

export function progress(client: HttpClient, id: string, signal?: AbortSignal): Promise<Progress> {
  return client.request(`/lessons/${encodeURIComponent(id)}/progress`, signal ? { signal } : {}).then(parseProgress);
}

export function saveProgress(
  client: HttpClient,
  id: string,
  position: number,
  percent: number,
  revision: number,
  signal?: AbortSignal,
): Promise<Progress> {
  return client
    .request(`/lessons/${encodeURIComponent(id)}/progress`, {
      method: 'PUT',
      body: { position, percent, expected_revision: revision },
      ...(signal ? { signal } : {}),
    })
    .then(parseProgress);
}
