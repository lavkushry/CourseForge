import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installContractFixture } from './fixture';

test.afterEach(async ({ page, context }) => {
  for (const current of context.pages()) {
    if (!current.isClosed() && (await current.locator('#back').isVisible())) {
      await current.locator('#back').click();
      await expect(current.locator('#catalog')).toBeVisible();
    }
  }
  if (!page.isClosed() && (await page.getByRole('button', { name: 'Sign out', exact: true }).isVisible())) {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  }
});

async function openLesson(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email address').fill('learner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('CourseForgeDemo2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Open course' }).click();
  if (await page.locator('#lesson-list').isVisible()) await page.locator('#lesson-list button').first().click();
  else {
    await page.getByRole('button', { name: 'Lessons', exact: true }).click();
    await page.locator('#drawer-lessons button').first().click();
  }
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready');
}

test('decodes real media, seeks, preserves speed, toggles theater and captures timestamps', async ({
  page,
  context,
}) => {
  await installContractFixture(context);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openLesson(page);
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(0.5);
  await expect
    .poll(() => page.locator('video').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames))
    .toBeGreaterThan(0);
  await page.locator('#speed').selectOption('1.5');
  await expect.poll(() => page.locator('video').evaluate(video => video.playbackRate)).toBe(1.5);
  await page.locator('#player-wrap').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(10);
  await page.getByRole('button', { name: 'Theater', exact: true }).click();
  await expect(page.locator('#theater')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Capture timestamp' }).click();
  await expect(page.locator('#notice')).toContainText(/timestamp|Lesson/);
  await expect(page.locator('#save-status')).toHaveText('Progress saved');
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.locator('#unlock-controls')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#unlock-controls')).toBeHidden();
  expect(errors).toEqual([]);
});

test('published preview permits enrollment before protected lesson playback, including mobile', async ({
  page,
  context,
}) => {
  await installContractFixture(context, { enrolled: false });
  await page.goto('/');
  await page.getByLabel('Email address').fill('learner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('CourseForgeDemo2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Open course' }).click();
  await expect(page.getByRole('button', { name: 'Enroll in this course' })).toBeVisible();
  await page.getByRole('button', { name: 'Enroll in this course' }).click();
  await expect(page.locator('#course-enrollment')).toBeHidden();
  if (await page.locator('#lesson-list').isVisible()) await page.locator('#lesson-list button').first().click();
  else {
    await page.getByRole('button', { name: 'Lessons', exact: true }).click();
    await page.locator('#drawer-lessons button').first().click();
  }
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready');
});

test('native controls remain usable if the optional Media Chrome asset fails', async ({ page, context }) => {
  await installContractFixture(context);
  await context.route('**/*media-chrome*', route => route.abort('failed'));
  await openLesson(page);
  await expect.poll(() => page.locator('video').evaluate(video => video.controls)).toBe(true);
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(0.3);
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(true);
});

test('offline pauses, releases and reconnect requires explicit reclaim', async ({ page, context }) => {
  const state = await installContractFixture(context);
  await openLesson(page);
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(0.2);
  await context.setOffline(true);
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'suspended');
  await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(true);
  await context.setOffline(false);
  await expect.poll(() => state.releases).toBeGreaterThan(0);
  const claims = state.claims;
  await page.waitForTimeout(300);
  expect(state.claims).toBe(claims);
  await page.getByRole('button', { name: 'Resume here', exact: true }).first().click();
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'playing');
  expect(state.claims).toBe(claims + 1);
});

test('autoplay disabled stays on ended media; enabling waits until ended and countdown', async ({ page, context }) => {
  await installContractFixture(context);
  await openLesson(page);
  await page.locator('video').evaluate(video => {
    video.currentTime = 29.5;
  });
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('video').evaluate(video => video.ended)).toBe(true);
  await expect(page.locator('#next-countdown')).toBeHidden();
  await page.waitForTimeout(1000);
  await expect(page.locator('#lesson-title')).toContainText('Lesson 1');
  await page.getByLabel('Play next lesson automatically').check();
  await page.locator('#restart').click();
  await page.locator('video').evaluate(video => {
    video.currentTime = 28;
  });
  await page.locator('#play-toggle').click();
  await expect(page.locator('#lesson-title')).toContainText('Lesson 1');
  await expect(page.locator('#next-countdown')).toBeHidden();
  await expect.poll(() => page.locator('video').evaluate(video => video.ended)).toBe(true);
  await expect(page.locator('#next-countdown')).toBeVisible();
  await expect(page.locator('#lesson-title')).toContainText('Lesson 2', { timeout: 12_000 });
});

test('canceling next countdown preserves the current lesson and drawer focus returns', async ({ page, context }) => {
  await installContractFixture(context);
  await openLesson(page);
  await page.getByLabel('Play next lesson automatically').check();
  await page.locator('video').evaluate(video => {
    video.currentTime = 29.5;
  });
  await page.locator('#play-toggle').click();
  await expect(page.locator('#next-countdown')).toBeVisible();
  await page.getByRole('button', { name: 'Stay here' }).click();
  await expect(page.locator('#next-countdown')).toBeHidden();
  await page.waitForTimeout(5500);
  await expect(page.locator('#lesson-title')).toContainText('Lesson 1');
  await page.getByRole('button', { name: 'Lessons', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Lessons', exact: true })).toBeFocused();
});

test('note retry after lost acknowledgement is duplicate-safe and explicit completion does not autoplay', async ({
  page,
  context,
}) => {
  const state = await installContractFixture(context);
  await openLesson(page);
  state.dropNextNote = true;
  await page.getByLabel('Add a note at the current timestamp').fill('A durable lesson note.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('Note could not save');
  expect(state.notes).toHaveLength(1);
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.locator('#note-list')).toContainText('A durable lesson note.');
  expect(state.notes).toHaveLength(1);
  await page.getByLabel('Play next lesson automatically').check();
  await page.getByRole('button', { name: 'Mark as complete', exact: true }).click();
  await expect(page.locator('#coverage')).toHaveText('Lesson completed');
  await expect(page.locator('#next-countdown')).toBeHidden();
  await expect(page.locator('#lesson-title')).toContainText('Lesson 1');
  await page.getByRole('button', { name: 'Delete note' }).click();
  await expect(page.locator('#note-list')).not.toContainText('A durable lesson note.');
});

test('second window needs explicit takeover and stale first window loses its lease', async ({ page, context }) => {
  await installContractFixture(context);
  await openLesson(page);
  await page.locator('#play-toggle').click();
  const second = await context.newPage();
  await second.goto('/');
  await second.getByRole('button', { name: 'Open course' }).click();
  if (await second.locator('#lesson-list').isVisible()) await second.locator('#lesson-list button').first().click();
  else {
    await second.getByRole('button', { name: 'Lessons', exact: true }).click();
    await second.locator('#drawer-lessons button').first().click();
  }
  await expect(second.locator('#player-wrap')).toHaveAttribute('data-state', 'conflict');
  await second.getByRole('button', { name: 'Move playback here' }).click();
  await expect(second.locator('#player-wrap')).toHaveAttribute('data-state', 'ready');
  await page.locator('#speed').selectOption('1.25');
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'lost');
  await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(true);
});
