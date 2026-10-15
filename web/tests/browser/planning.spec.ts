import { expect, test, type Page } from '@playwright/test';
const at = '2026-10-13T12:00:00Z';
const item = {
  id: 'item',
  item_key: 'lesson:l',
  kind: 'lesson',
  title: 'Synthetic lesson',
  description: 'A real source suggestion',
  minutes: 15,
  actual_minutes: 0,
  status: 'pending',
  revision: 1,
  action: { view: 'learning', lesson_id: 'lesson', position: 12 },
};
const makeDay = () => ({
  id: 'day',
  study_date: '2026-10-13',
  timezone: 'UTC',
  revision: 1,
  budget_minutes: 45,
  planned_minutes: 15,
  reported_done_minutes: 0,
  actual_minutes: 0,
  completed_count: 0,
  items: [{ ...item }],
  warnings: [],
  disclaimer: 'Checklist completion does not verify mastery.',
});
const habit = {
  day: '2026-10-13',
  today: { watched_seconds: 0, lessons: 0, quizzes: 0, reviews: 0, goal_met: false },
  week: { watched_seconds: 0, lessons: 0, quizzes: 0, reviews: 0, active_days: 0 },
  streak: 0,
  best_streak: 0,
  preferences: { goal: 'minutes', timezone: 'UTC', reminder_email: false, initialized: false },
  email_available: false,
  reminder_delivery_available: false,
  timezone_anchored: false,
};
async function mount(page: Page, tab = 'daily') {
  await page.goto('/');
  await page.evaluate(async tab => {
    const [{ PlanningView }, { ApiClient }] = await Promise.all([
      import('/src/planning/view.ts'),
      import('/src/api.ts'),
    ]);
    const root = document.createElement('section');
    root.id = 'planning-fixture';
    document.body.replaceChildren(root);
    const view = new PlanningView(root, new ApiClient(), {
      unauthorized() {
        document.body.textContent = 'Account access ended';
      },
      async navigate(action: unknown) {
        (window as unknown as { __planningAction?: unknown; __planning?: { close(): void } }).__planningAction = action;
      },
      async paths() {
        return [{ id: 'path', goal: 'Synthetic path' }];
      },
      currentLesson() {
        return { id: 'lesson', title: 'Synthetic lesson' };
      },
    });
    (window as unknown as { __planningAction?: unknown; __planning?: { close(): void } }).__planning = view;
    await view.open(tab as 'daily' | 'weekly' | 'focus' | 'habits' | 'roadmap');
  }, tab);
  await expect(page.locator('#planning-fixture')).toHaveAttribute('aria-busy', 'false');
}
async function fixtures(page: Page) {
  let day = makeDay();
  let pref = { daily_minutes: 45, path_id: null as string | null, revision: 0 };
  let wp = { weekday_minutes: [45, 45, 45, 45, 45, 0, 0], revision: 0 };
  let week: unknown = null;
  let focus: unknown = null;
  let habits = structuredClone(habit);
  const writes: Array<{ path: string; body: unknown; key: string | undefined }> = [];
  let uncertain = true;
  await page.route('**/api/v1/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/v1', '');
    const body = req.postDataJSON();
    if (req.method() !== 'GET') writes.push({ path, body, key: req.headers()['idempotency-key'] });
    let data: unknown;
    let status = 200;
    if (path === '/auth/me') {
      await route.fulfill({ status: 401, json: { error: { message: 'Fixture logged out' } } });
      return;
    }
    if (path === '/me/habits') data = habits;
    else if (path === '/me/habit-preferences') {
      habits = {
        ...habits,
        timezone_anchored: true,
        preferences: { ...habits.preferences, ...body, initialized: true },
      };
      data = habits;
    } else if (path === '/planner/preferences') {
      if (req.method() === 'PUT')
        pref = { daily_minutes: body.daily_minutes, path_id: body.path_id, revision: pref.revision + 1 };
      data = pref;
    } else if (path === '/planner/week-preferences') {
      if (req.method() === 'PUT') wp = { weekday_minutes: body.weekday_minutes, revision: wp.revision + 1 };
      data = wp;
    } else if (path.startsWith('/planner/days/')) {
      data = day;
    } else if (path === '/planner/days') {
      day = { ...day, study_date: body.study_date, revision: day.revision + 1 };
      data = day;
    } else if (path.startsWith('/planner/items/')) {
      if (path.endsWith('/actual')) {
        if (uncertain) {
          uncertain = false;
          await route.fulfill({ status: 503, json: { error: { message: 'Uncertain command response' } } });
          return;
        }
        day.actual_minutes = body.actual_minutes;
        day.items[0]!.actual_minutes = body.actual_minutes;
      } else {
        day.items[0]!.status = body.status;
        day.completed_count = body.status === 'done' ? 1 : 0;
      }
      day.items[0]!.revision++;
      data = day;
    } else if (path.startsWith('/planner/weeks/')) {
      if (!week) status = 404;
      data = week;
    } else if (path === '/planner/weeks') {
      const start = new Date(body.week_start + 'T12:00:00Z');
      week = {
        id: 'week',
        week_start: body.week_start,
        timezone: 'UTC',
        revision: 1,
        budget_minutes: 225,
        planned_minutes: 75,
        actual_minutes: 0,
        forecast_reviews: 0,
        unscheduled_reviews: 0,
        warnings: [],
        disclaimer: 'Review forecasts are suggestions.',
        days: wp.weekday_minutes.map((n, i) => {
          const d = new Date(start);
          d.setUTCDate(d.getUTCDate() + i);
          return {
            date: d.toISOString().slice(0, 10),
            weekday: i,
            budget_minutes: n,
            rest_day: n === 0,
            planned_minutes: n ? 15 : 0,
            actual_minutes: 0,
            completed_count: 0,
            task_count: n ? 1 : 0,
            forecast_reviews: 0,
            forecast_overdue: 0,
          };
        }),
      };
      data = week;
    } else if (path === '/focus/active') data = { session: focus, server_now: at };
    else if (path === '/focus/sessions') {
      focus = {
        id: 'focus',
        mode: body.mode,
        status: 'running',
        title: body.title,
        duration_seconds: body.duration_minutes * 60,
        elapsed_seconds: 0,
        remaining_seconds: body.duration_minutes * 60,
        revision: 1,
        server_now: at,
        created_at: at,
      };
      data = focus;
    } else if (path.endsWith('/actions')) {
      focus = {
        ...focus,
        status: { pause: 'paused', hidden: 'paused', resume: 'running', finish: 'finished', cancel: 'cancelled' }[
          body.action as string
        ],
        revision: focus.revision + 1,
        elapsed_seconds: 12,
        remaining_seconds: focus.duration_seconds - 12,
      };
      data = focus;
      if (['finished', 'cancelled'].includes(focus.status)) focus = null;
    } else if (path === '/focus/history') data = { sessions: [], next_cursor: '', server_now: at };
    else if (path.startsWith('/focus/analytics/'))
      data = {
        week_start: '2026-10-12',
        timezone: 'UTC',
        days: [],
        measured_minutes: 0,
        self_reported_minutes: 0,
        planned_minutes: 0,
        active_days: 0,
        disclaimer: 'Measured focus is timer wall-clock time.',
      };
    else if (path === '/studio/insights')
      data = {
        due_count: 2,
        total_cards: 4,
        reviews_today: 0,
        streak_days: 0,
        mastery_signal_percent: null,
        mastery_basis: 'Self-rated recall is not assessed mastery',
        period: 'UTC recall activity',
        weekly_reviews: [],
        weak_areas: [],
        history: [],
      };
    else {
      status = 404;
      data = { error: { message: 'Unknown fixture endpoint' } };
    }
    await route.fulfill({ status, json: data ?? { error: { message: 'No saved plan' } } });
  });
  return writes;
}
test('daily controls retain revisions, uncertain retry keys and separate reported time', async ({ page }) => {
  const writes = await fixtures(page);
  await mount(page);
  await page.getByLabel('Daily study minutes').fill('30');
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await expect(page.getByLabel('Daily study minutes')).toHaveValue('30');
  await page.getByRole('button', { name: 'Mark done: Synthetic lesson', exact: true }).click();
  await expect(page.getByText('1/1 checklist complete', { exact: false })).toBeVisible();
  await page.getByLabel('Reported minutes for Synthetic lesson').fill('7');
  await page.getByRole('button', { name: 'Save time', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Uncertain');
  await page.getByRole('button', { name: 'Save time', exact: true }).click();
  await expect(page.getByText('7 min self-reported', { exact: false })).toBeVisible();
  const attempts = writes.filter(w => w.path.endsWith('/actual'));
  expect(attempts).toHaveLength(2);
  expect(attempts[0]!.key).toBe(attempts[1]!.key);
  expect(attempts[0]!.body).toEqual({ actual_minutes: 7, expected_revision: 2 });
  await page.getByRole('button', { name: 'Open source', exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { __planningAction?: unknown; __planning?: { close(): void } }).__planningAction,
    ),
  ).toEqual({ view: 'learning', lesson_id: 'lesson', position: 12 });
  expect(writes.every(w => w.key)).toBe(true);
  await expect(page.locator('body')).not.toContainText('NaN');
});
test('weekly budgets, rest days and daily navigation', async ({ page }) => {
  await fixtures(page);
  await mount(page, 'weekly');
  await page.getByLabel('Mon study minutes').fill('30');
  await page.getByRole('button', { name: 'Build weekly calendar' }).click();
  await expect(page.getByText('Rest day', { exact: true })).toHaveCount(2);
  await expect(page.getByLabel('Week containing')).toHaveValue('2026-10-12');
  await page.getByRole('button', { name: 'Open day 2026-10-13', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Daily plan', exact: true })).toBeVisible();
  expect(await page.locator('body').evaluate(b => b.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
test('focus restoration, pause, resume, finish and cancel keep server ownership', async ({ page }) => {
  const writes = await fixtures(page);
  await mount(page, 'focus');
  await page.getByRole('button', { name: 'Focus on current lesson' }).click();
  await page.getByLabel('Duration minutes').fill('1');
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  await expect(page.getByText('Focus · running', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByText('Focus · paused', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByRole('button', { name: 'Finish session', exact: true }).click();
  await expect(page.getByText('No active timer', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel session', exact: true }).click();
  const start = writes.find(w => w.path === '/focus/sessions');
  expect(start!.body.lesson_id).toBe('lesson');
  expect(writes.filter(w => w.path.endsWith('/actions')).map(w => w.body.expected_revision)).toEqual([1, 2, 3, 1]);
  expect(writes.some(w => 'elapsed_seconds' in w.body)).toBe(false);
});
test('habits anchor timezone and state unavailable reminders without invented credit', async ({ page }) => {
  await fixtures(page);
  await mount(page, 'habits');
  await page.getByLabel('Learning timezone').fill('Asia/Kolkata');
  await page.getByLabel('Daily habit goal').selectOption('lesson');
  await page.getByLabel('Send a weekly learning reminder').check();
  await page.getByRole('button', { name: 'Save habit preferences' }).click();
  await expect(page.getByLabel('Learning timezone')).toBeDisabled();
  await expect(page.getByLabel('Learning timezone')).toHaveValue('Asia/Kolkata');
  await expect(page.getByText('Delivery is not available', { exact: false })).toBeVisible();
  await expect(page.getByText('0 watched minutes', { exact: false })).toHaveCount(2);
  await page.getByRole('button', { name: 'Recall insights', exact: true }).click();
  await expect(page.getByText('No recall signal yet.', { exact: true })).toBeVisible();
});
test('disposal aborts stale response and clears private DOM', async ({ page }) => {
  await fixtures(page);
  await mount(page);
  await page.evaluate(() => {
    (window as unknown as { __planningAction?: unknown; __planning?: { close(): void } }).__planning.close();
  });
  await expect(page.locator('#planning-fixture')).toBeHidden();
  await expect(page.locator('#planning-fixture')).toBeEmpty();
});
