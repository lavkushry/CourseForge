import type { BrowserContext, Route } from '@playwright/test';
import type { Bookmark, Card, Grade, QuizResult, ReviewAttempt } from '../../src/learning/contracts';

// Isolated behavioral simulation for the prewritten learning UI contract. This
// never contacts providers and does not establish Go/database correctness.
export async function installLearningFixture(context: BrowserContext) {
  const now = '2026-10-12T12:00:00Z';
  const bookmarks: Bookmark[] = [1, 2, 3].map(n => ({
    id: `bm-${n}`,
    lesson_id: 'fixture-lesson-1',
    label: `Saved idea ${n}`,
    position: n,
    created_at: now,
  }));
  const cards: Card[] = [];
  const quizAttempts: QuizResult[] = [];
  const reviewAttempts: ReviewAttempt[] = [];
  const commands = new Map<string, { fingerprint: string; result: unknown }>();
  const bookmarkPosts: { key: string; position: number }[] = [];
  const quizPosts: string[] = [];
  const gradePosts: string[] = [];
  const completePosts: string[] = [];
  const state = {
    bookmarks,
    cards,
    quizAttempts,
    reviewAttempts,
    bookmarkPosts,
    quizPosts,
    gradePosts,
    completePosts,
    dropBookmark: false,
    dropQuiz: false,
    dropGrade: false,
    dropComplete: false,
    bookmarkDelay: 0,
    quizPending: false,
    staleQuiz: false,
    denied: false,
    denialStatus: 401,
    revision: 1,
    completions: 0,
  };
  const json = (route: Route, data: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(data),
    });
  const page = (route: Route, items: unknown[], key: string, url: URL) => {
    const offset = Number(url.searchParams.get('cursor') || 0);
    return json(route, {
      [key]: items.slice(offset, offset + 2),
      next_cursor: items.length > offset + 2 ? String(offset + 2) : '',
    });
  };
  await context.route('**/api/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    if (!/\/(bookmarks|quiz|quizzes)(\/|$)/.test(path) && !/^\/(bookmarks|reviews)(\/|$)/.test(path))
      return route.fallback();
    if (state.denied)
      return json(route, { detail: 'Your sign-in expired.', code: 'unauthenticated' }, state.denialStatus);
    if (method !== 'GET' && req.headers()['x-csrf-token'] !== 'synthetic-csrf')
      return json(route, { detail: 'CSRF required.' }, 403);
    const body = method === 'POST' ? (req.postDataJSON() as Record<string, unknown>) : {};
    const lesson = /^\/lessons\/([^/]+)/.exec(path)?.[1] || '';
    if (method === 'POST') {
      const key = req.headers()['idempotency-key'] || '';
      if (!key) return json(route, { detail: 'Command key required.' }, 422);
      const fingerprint = `${path}:${JSON.stringify(body)}`;
      const previous = commands.get(key);
      if (previous && previous.fingerprint !== fingerprint)
        return json(route, { detail: 'Command changed.', code: 'idempotency_conflict' }, 409);
      if (path.endsWith('/bookmarks')) bookmarkPosts.push({ key, position: Number(body.position) });
      if (path.endsWith('/quiz/attempts')) quizPosts.push(key);
      if (path.endsWith('/grade')) gradePosts.push(key);
      if (path.endsWith('/complete')) completePosts.push(key);
      if (previous) return json(route, previous.result, 201);
      let output: unknown;
      if (path.endsWith('/bookmarks')) {
        const b = {
          id: `bm-new-${bookmarks.length}`,
          lesson_id: lesson,
          label: String(body.label),
          position: Number(body.position),
          created_at: now,
        };
        bookmarks.push(b);
        output = b;
      } else if (path.endsWith('/quiz/attempts')) {
        if (state.staleQuiz || body.revision !== state.revision) {
          state.staleQuiz = false;
          state.revision++;
          return json(route, { detail: 'The quiz changed.', code: 'stale_revision' }, 409);
        }
        const answers = body.answers as Record<string, number>;
        const passed = answers.q1 === 0 && answers.q2 === 1;
        const graded: QuizResult = {
          attempt_id: `qa-${quizAttempts.length}`,
          quiz_id: 'quiz-1',
          lesson_id: lesson,
          revision: state.revision,
          score: passed ? 100 : 50,
          passed,
          correct_count: passed ? 2 : 1,
          total_count: 2,
          passing_threshold: 70,
          completed_at: now,
          suggested_review: 'Review the cited moments.',
          feedback: [
            {
              question_id: 'q1',
              correct: answers.q1 === 0,
              chosen_index: answers.q1 ?? 0,
              correct_index: 0,
              explanation: 'A lease protects playback ownership.',
              source_start: 4,
              concept: 'Ownership',
            },
            {
              question_id: 'q2',
              correct: answers.q2 === 1,
              chosen_index: answers.q2 ?? 0,
              correct_index: 1,
              explanation: 'Durable acknowledgement confirms saved progress.',
              source_start: 8,
              concept: 'Durability',
            },
          ],
        };
        quizAttempts.unshift(graded);
        output = graded;
      } else if (path === '/reviews/cards') {
        const c: Card = {
          id: `card-${cards.length}`,
          course_id: String(body.course_id),
          lesson_id: String(body.lesson_id),
          question: String(body.question),
          answer: String(body.answer),
          source_start: Number(body.source_start),
          revision: 1,
          repetitions: 0,
          interval_days: 0,
          due_at: now,
        };
        cards.push(c);
        output = c;
      } else if (path.endsWith('/grade')) {
        const card = cards.find(c => path === `/reviews/${c.id}/grade`);
        if (!card) return json(route, { detail: 'Missing card.' }, 404);
        if (body.expected_revision !== card.revision)
          return json(route, { detail: 'Card schedule changed.', code: 'stale_revision' }, 409);
        card.revision++;
        card.repetitions++;
        card.interval_days = 1;
        card.due_at = '2099-10-13T12:00:00Z';
        const accepted: Grade = {
          attempt_id: `ra-${reviewAttempts.length}`,
          card_id: card.id,
          revision: card.revision,
          due_at: card.due_at,
          interval_days: 1,
          repetitions: card.repetitions,
        };
        reviewAttempts.unshift({
          id: accepted.attempt_id,
          card_id: card.id,
          course_id: card.course_id,
          quality: Number(body.quality),
          reviewed_at: now,
          schedule: { due_at: card.due_at, interval_days: 1 },
        });
        output = accepted;
      } else if (path === '/reviews/complete') {
        state.completions++;
        output = {
          session_id: `rs-${state.completions}`,
          status: 'completed',
          cards_reviewed: (body.attempt_ids as string[]).length,
          habit_credited: true,
          completed_at: now,
        };
      } else return json(route, { detail: 'Unknown learning write.' }, 404);
      commands.set(key, { fingerprint, result: output });
      const drop = path.endsWith('/bookmarks')
        ? 'dropBookmark'
        : path.endsWith('/quiz/attempts')
          ? 'dropQuiz'
          : path.endsWith('/grade')
            ? 'dropGrade'
            : path.endsWith('/complete')
              ? 'dropComplete'
              : null;
      if (drop && state[drop]) {
        state[drop] = false;
        return route.abort('failed');
      }
      return json(route, output, 201);
    }
    if (path.endsWith('/bookmarks')) {
      if (state.bookmarkDelay) {
        const delay = state.bookmarkDelay;
        state.bookmarkDelay = 0;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      return page(
        route,
        bookmarks.filter(b => b.lesson_id === lesson),
        'bookmarks',
        url,
      ).catch(() => undefined);
    }
    if (path.startsWith('/bookmarks/') && method === 'DELETE') {
      const index = bookmarks.findIndex(b => path === `/bookmarks/${b.id}`);
      if (index >= 0) bookmarks.splice(index, 1);
      return json(route, { ok: true });
    }
    if (path.endsWith('/quizzes/status'))
      return json(route, {
        status: Object.fromEntries(
          quizAttempts.filter(a => a.passed).map(a => [a.lesson_id, { passed: true, score: a.score }]),
        ),
        next_cursor: '',
      });
    if (path.endsWith('/quiz'))
      return json(
        route,
        state.quizPending || lesson !== 'fixture-lesson-1'
          ? { state: 'pending', lesson_id: lesson, questions: [] }
          : {
              state: 'ready',
              quiz_id: 'quiz-1',
              lesson_id: lesson,
              revision: state.revision,
              questions: [
                {
                  id: 'q1',
                  question: 'What protects playback ownership?',
                  options: ['A lease', 'A browser label'],
                  concept: 'Ownership',
                },
                {
                  id: 'q2',
                  question: 'When is progress saved?',
                  options: ['Before the request', 'After acknowledgement'],
                  concept: 'Durability',
                },
              ],
              status: {
                attempts: quizAttempts.length,
                passed: quizAttempts.some(a => a.passed),
                last_score: quizAttempts[0]?.score ?? null,
              },
            },
      );
    if (path.endsWith('/quiz/attempts'))
      return page(
        route,
        quizAttempts.filter(a => a.lesson_id === lesson),
        'attempts',
        url,
      );
    if (path === '/reviews/cards' || path === '/reviews/due')
      return page(
        route,
        cards.filter(
          c =>
            c.course_id === url.searchParams.get('course') &&
            (path.endsWith('/cards') || c.due_at !== '2099-10-13T12:00:00Z'),
        ),
        'cards',
        url,
      );
    if (path === '/reviews/history') return page(route, reviewAttempts, 'attempts', url);
    return route.fallback();
  });
  return state;
}
