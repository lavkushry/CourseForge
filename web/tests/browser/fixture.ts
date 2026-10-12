import { readFile } from 'node:fs/promises';
import type { BrowserContext, Route } from '@playwright/test';
import type { Lesson, Note, PlayerPreferences, Pulse } from '../../src/contracts';

// This provider is a behavioral contract simulator, never a capacity claim or a
// substitute for the separate browser tests against the real Go/PostgreSQL stack.
export async function installContractFixture(context: BrowserContext, options: { enrolled?: boolean } = {}) {
  const media = await readFile(process.env.COURSEFORGE_TEST_MEDIA || '/tmp/courseforge-rewrite-media/lecture.mp4');
  const course = { id: 'fixture-course', title: 'CourseForge demonstration', description: 'Synthetic lessons.', enrolled: options.enrolled ?? true };
  const lessons: Lesson[] = [1, 2, 3].map(index => ({ id: `fixture-lesson-${index}`, course_id: course.id, title: `Lesson ${index} — Playback and progress`, duration_seconds: 30 }));
  const auth = { user: { id: 'fixture_learner', name: 'Demo learner', email: 'learner@example.test' }, csrf_token: 'synthetic-csrf' };
  let loggedIn = false;
  let owner: string | null = null;
  let counter = 0;
  let preferences: PlayerPreferences = { speed: 1, autoplay: false };
  const sessions = new Map<string, { lessonId: string; sequence: number }>();
  const progress = new Map<string, { position: number; watched_seconds: number; coverage: number; percent: number; completed: boolean; revision: number }>();
  const noteKeys = new Map<string, Note>();
  const notes: Note[] = [];
  const saved = new Map<string, { id: string; item_type: string; course_id: string; title: string }>();
  const pulses: Pulse[] = [];
  const state = { dropNextNote: false, mediaFailures: 0, failNextMediaGet: false, truncateNextMediaGet: false, stallNextMediaGetMs: 0, permanentMediaStatus: 0, delayedMediaMs: 0, mediaRequests: 0, mediaProbes: 0, releases: 0, claims: 0, notes, pulses, get owner() { return owner; } };
  const currentProgress = (id: string) => {
    let value = progress.get(id);
    if (!value) { value = { position: 0, watched_seconds: 0, coverage: 0, percent: 0, completed: false, revision: 0 }; progress.set(id, value); }
    return value;
  };
  const json = (route: Route, data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  await context.route('**/api/v1/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    const body = method === 'POST' || method === 'PUT' ? request.postDataJSON() as Record<string, unknown> : {};
    if (path === '/auth/me') return json(route, loggedIn ? auth : { detail: 'Sign in.', code: 'unauthenticated' }, loggedIn ? 200 : 401);
    if (path === '/auth/login') { loggedIn = true; return json(route, auth); }
    if (!loggedIn) return json(route, { detail: 'Sign in.', code: 'unauthenticated' }, 401);
    if (method !== 'GET' && request.headers()['x-csrf-token'] !== auth.csrf_token) return json(route, { detail: 'CSRF token required.', code: 'csrf_required' }, 403);
    if (path === '/auth/logout') { loggedIn = false; return json(route, { ok: true }); }
    if (path === '/courses' || path === '/public/courses') {
      const query = url.searchParams.get('q')?.toLowerCase() || '';
      return json(route, { courses: course.title.toLowerCase().includes(query) ? [course] : [], next_cursor: '' });
    }
    if (path === '/streaming/continue-watching') return json(route, { items: lessons.filter(lesson => { const item = progress.get(lesson.id); return item && item.position > 10 && !item.completed; }).map(lesson => ({ ...lesson, ...currentProgress(lesson.id) })) });
    if (path === '/streaming/my-list') {
      if (method === 'POST') { saved.set(`${body.item_type}:${body.item_id}`, { id: String(body.item_id), item_type: String(body.item_type), course_id: course.id, title: course.title }); return json(route, { saved: true }, 201); }
      return json(route, { items: [...saved.values()], next_cursor: '' });
    }
    if (path.startsWith('/streaming/my-list/') && method === 'DELETE') { const [, , , type, id] = path.split('/'); saved.delete(`${type}:${id}`); return json(route, { removed: true }); }

    if (path === `/courses/${course.id}/quizzes/status`) return json(route, { status: {}, next_cursor: '' });
    if (path === `/courses/${course.id}/enroll` && method === 'POST') { course.enrolled = true; return json(route, { enrolled: true }, 201); }
    if (path === `/courses/${course.id}` && !course.enrolled) return json(route, { detail: 'Enroll to access this course.' }, 404);
    if (path === `/courses/${course.id}` || path === `/public/courses/${course.id}`) return json(route, { course, lessons, next_cursor: '' });
    if (path === '/player/preferences') {
      if (method === 'PUT') preferences = { autoplay: body.autoplay === true, speed: Number(body.speed) };
      return json(route, preferences);
    }
    const lessonMatch = /^\/lessons\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (lessonMatch) {
      const lessonId = lessonMatch[1] || '';
      if (!course.enrolled) return json(route, { detail: 'Lesson not found.' }, 404);
      const lesson = lessons.find(item => item.id === lessonId);
      if (!lesson) return json(route, { detail: 'Lesson not found.' }, 404);
      const tail = lessonMatch[2];
      const value = currentProgress(lessonId);
      if (!tail) return json(route, { lesson, progress: value });
      if (tail === 'progress') {
        if (method === 'PUT') {
          if (body.expected_revision !== value.revision) return json(route, { detail: 'Progress changed.', code: 'stale_progress' }, 409);
          value.position = Number(body.position); value.percent = Number(body.percent); value.completed = value.percent === 100; value.revision += 1;
        }
        return json(route, value);
      }
      if (tail === 'notes' && method === 'GET') return json(route, { notes: notes.filter(note => note.lesson_id === lessonId), next_cursor: '' });
      if (tail === 'notes' && method === 'POST') {
        const key = request.headers()['idempotency-key'];
        if (!key) return json(route, { detail: 'Idempotency key required.' }, 422);
        let note = noteKeys.get(key);
        if (!note) {
          note = { id: `note-${notes.length + 1}`, lesson_id: lessonId, content: String(body.content), position: Number(body.position), created_at: new Date().toISOString() };
          notes.push(note); noteKeys.set(key, note);
        }
        if (state.dropNextNote) { state.dropNextNote = false; await route.abort('failed'); return; }
        return json(route, note, 201);
      }
      if (tail?.startsWith('notes/') && method === 'DELETE') { const index = notes.findIndex(note => note.id === tail.slice(6)); if (index >= 0) notes.splice(index, 1); return json(route, { ok: true }); }
    }
    if (path === '/playback/sessions' && method === 'POST') {
      if (owner && body.take_over !== true) return json(route, { detail: 'Playback is open elsewhere.', code: 'playback_conflict' }, 409);
      const lessonId = String(body.lesson_id);
      const value = currentProgress(lessonId);
      const id = `session-${++counter}`;
      sessions.set(id, { lessonId, sequence: 0 }); owner = id;
      return json(route, { id, media_url: `/media/v1/${id}`, position: value.position, sequence: 0, preferences, owner: true }, 201);
    }
    const playbackMatch = /^\/playback\/sessions\/([^/]+)\/(pulse|claim|release)$/.exec(path);
    if (playbackMatch) {
      const id = playbackMatch[1] || '';
      const operation = playbackMatch[2];
      const session = sessions.get(id);
      if (!session) return json(route, { detail: 'Session not found.' }, 404);
      const value = currentProgress(session.lessonId);
      if (operation === 'release') { state.releases += 1; if (owner === id) owner = null; return json(route, { owner: false }); }
      if (operation === 'claim') {
        state.claims += 1;
        if (owner && owner !== id && body.take_over !== true) return json(route, { detail: 'Playback is open elsewhere.', code: 'playback_conflict' }, 409);
        owner = id;
        return json(route, { owner: true, position: value.position, sequence: session.sequence });
      }
      const pulse = body as unknown as Pulse;
      pulses.push(pulse);
      if (owner === id && pulse.sequence > session.sequence) {
        session.sequence = pulse.sequence; value.position = pulse.position;
        value.watched_seconds += Math.max(0, Math.min(pulse.elapsed_seconds, 20));
        value.coverage = Math.min(100, value.watched_seconds / 30 * 100);
        value.revision += 1;
        if (pulse.kind === 'ended' && value.coverage >= 90) value.completed = true;
      }
      return json(route, { sequence: Math.max(session.sequence, pulse.sequence), position: value.position, watched_seconds: value.watched_seconds, coverage: value.coverage, completed: value.completed, owner: owner === id });
    }
    return json(route, { detail: `Unimplemented fixture operation ${method} ${path}` }, 404);
  });
  await context.route('**/media/**', async route => {
    const request = route.request();
    if (request.method() === 'HEAD') state.mediaProbes += 1; else state.mediaRequests += 1;
    if (state.stallNextMediaGetMs && request.method() === 'GET') { const delay = state.stallNextMediaGetMs; state.stallNextMediaGetMs = 0; await new Promise(resolve => setTimeout(resolve, delay)); }
    if (state.truncateNextMediaGet && request.method() === 'GET') { state.truncateNextMediaGet = false; await route.fulfill({ status: 200, contentType: 'video/mp4', body: media.subarray(0, 64) }).catch(() => undefined); return; }

    if (state.delayedMediaMs) { const delay = state.delayedMediaMs; state.delayedMediaMs = 0; await new Promise(resolve => setTimeout(resolve, delay)); }
    const failGet = state.failNextMediaGet && request.method() === 'GET';
    if (state.permanentMediaStatus || state.mediaFailures > 0 || failGet) {
      if (state.mediaFailures > 0) state.mediaFailures -= 1;
      if (failGet) state.failNextMediaGet = false;
      await route.fulfill({ status: state.permanentMediaStatus || 503, headers: { 'Retry-After': '0' }, body: '' }).catch(() => undefined);
      return;
    }
    const range = route.request().headers().range;
    const parts = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
    const start = parts ? Number(parts[1]) : 0;
    const end = parts && parts[2] ? Math.min(Number(parts[2]), media.length - 1) : media.length - 1;
    if (start >= media.length || start > end) return route.fulfill({ status: 416, headers: { 'Content-Range': `bytes */${media.length}` } });
    return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: media.subarray(start, end + 1), headers: { 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${media.length}` } : {}) } }).catch(() => undefined);
  });
  return state;
}
