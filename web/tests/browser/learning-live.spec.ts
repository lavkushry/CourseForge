import { expect, test } from '@playwright/test';
// Opt-in, synthetic-only browser proof through actual Go/PostgreSQL and the
// separate media gateway. Every run creates and deletes its own fixture account.
test('isolated Go: bookmarks, curated quiz feedback and a private review session survive tool navigation and replica reads', async ({
  page,
  context,
}, info) => {
  test.skip(
    process.env.COURSEFORGE_BROWSER_STACK !== 'synthetic-rewrite',
    'Requires explicitly isolated rewrite fixture stack.',
  );
  const origin = process.env.COURSEFORGE_WEB_URL || 'http://127.0.0.1:5173';
  expect(new URL(origin).hostname).toBe('127.0.0.1');
  expect(new URL(origin).port).toBe('5173');
  const publicResponse = await context.request.get(`${origin}/api/v1/public/courses/fixture-course`);
  expect(publicResponse.status()).toBe(200);
  const fixture = (await publicResponse.json()) as {
    course: { title: string; description: string };
    lessons: { id: string; title: string }[];
  };
  expect(fixture.course.description.toLowerCase()).toContain('synthetic');
  const email = `learning-ui-${info.project.name}-${Date.now()}@example.test`;
  const password = 'SyntheticLearningUI2026!';
  const registered = await context.request.post(`${origin}/api/v1/auth/register`, {
    headers: { Origin: origin },
    data: { email, password, name: 'Synthetic learning UI learner' },
  });
  expect(registered.status()).toBe(201);
  const auth = (await registered.json()) as { csrf_token: string };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let checks = 0;
  try {
    await page.goto('/');
    await page
      .locator('.course-card')
      .filter({ hasText: fixture.course.title })
      .getByRole('button', { name: 'Open course' })
      .click();
    await page.getByRole('button', { name: 'Enroll in this course' }).click();
    await expect(page.locator('#course-enrollment')).toBeHidden();
    if (await page.locator('#lesson-list').isVisible()) await page.locator('#lesson-list button').last().click();
    else {
      await page.getByRole('button', { name: 'Lessons', exact: true }).click();
      await page.locator('#drawer-lessons button').last().click();
    }
    await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('#learning-tools')).toBeVisible();
    checks++;
    await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
    await page.getByLabel('Bookmark label').fill('Synthetic browser saved idea');
    await page.getByRole('button', { name: 'Save bookmark', exact: true }).click();
    await expect(page.locator('.learning-status')).toContainText('Bookmark saved');
    await expect(page.locator('.learning-list')).toContainText('Synthetic browser saved idea');
    checks++;
    const bookmarks = await context.request.get('http://127.0.0.1:18091/api/v1/lessons/fixture-lesson-3/bookmarks');
    expect(bookmarks.status()).toBe(200);
    const b = (await bookmarks.json()) as { bookmarks: { label: string }[] };
    expect(b.bookmarks.map(v => v.label)).toContain('Synthetic browser saved idea');
    checks++;
    await page.getByRole('button', { name: 'Lesson quiz', exact: true }).click();
    await expect(page.getByRole('form', { name: 'Lesson quiz' })).toBeVisible();
    expect(await page.locator('.quiz-feedback').count()).toBe(0);
    for (const q of await page.locator('.quiz-question').all()) await q.getByRole('radio').first().check();
    await page.getByRole('button', { name: 'Submit quiz' }).click();
    await expect(page.locator('.quiz-result')).toContainText(/% · Passed|% · Keep practising/);
    await expect(page.locator('.learning-attempt')).toHaveCount(1);
    checks++;
    const attempts = await context.request.get('http://127.0.0.1:18091/api/v1/lessons/fixture-lesson-3/quiz/attempts');
    expect(attempts.status()).toBe(200);
    expect(((await attempts.json()) as { attempts: unknown[] }).attempts).toHaveLength(1);
    checks++;
    await page.getByRole('button', { name: 'Review cards', exact: true }).click();
    await page.getByLabel('Card question').fill('Which action confirms this review?');
    await page.getByLabel('Card answer').fill('The server acknowledges the grade.');
    await page.getByRole('button', { name: 'Create review card', exact: true }).click();
    await expect(page.locator('.learning-status')).toContainText('review card is saved');
    checks++;
    const authored = page.locator('.learning-row').filter({ hasText: 'Which action confirms this review?' });
    await authored.getByRole('button', { name: 'Review card', exact: true }).click();
    await expect(page.locator('.review-answer')).toBeHidden();
    await page.getByRole('button', { name: 'Reveal answer' }).click();
    await page.getByRole('button', { name: '4 · Remembered' }).click();
    await expect(page.locator('.review-study')).toContainText('Recall saved');
    checks++;
    await page.getByRole('button', { name: 'Finish review' }).click();
    await expect(page.locator('.learning-status')).toContainText('Review saved · 1 cards');
    await expect(page.getByText('Recall 4/5', { exact: true })).toBeVisible();
    checks++;
    const history = await context.request.get('http://127.0.0.1:18091/api/v1/reviews/history?course=fixture-course');
    expect(history.status()).toBe(200);
    expect(((await history.json()) as { attempts: unknown[] }).attempts).toHaveLength(1);
    checks++;
    await page.getByRole('button', { name: 'Lesson quiz', exact: true }).click();
    await expect(page.locator('.learning-attempt')).toHaveCount(1);
    await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
    await page.getByRole('button', { name: 'Delete bookmark' }).click();
    await expect(page.locator('.learning-list')).not.toContainText('Synthetic browser saved idea');
    checks++;
    expect(errors).toEqual([]);
  } finally {
    if (!page.isClosed() && (await page.locator('#back').isVisible())) {
      await page.locator('#back').click();
      await expect(page.locator('#catalog')).toBeVisible();
    }
    const deleted = await context.request.delete(`${origin}/api/v1/auth/me`, {
      headers: { Origin: origin, 'X-CSRF-Token': auth.csrf_token },
      data: { password },
    });
    expect(deleted.ok()).toBe(true);
    await info.attach('learning-synthetic-summary', {
      body: JSON.stringify({
        project: info.project.name,
        passedBehaviorChecks: checks,
        syntheticAccountRemoved: deleted.ok(),
        api: 'real Go replicas 18090/18091',
        media: 'separate gateway 18094',
        capacityProven: false,
        providerPlaybackProven: false,
      }),
      contentType: 'application/json',
    });
  }
});
