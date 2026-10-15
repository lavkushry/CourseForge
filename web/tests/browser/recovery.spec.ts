import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installContractFixture } from './fixture';

async function enterClassroom(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email address').fill('learner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('CourseForgeDemo2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Open course' }).click();
}
async function chooseLesson(page: Page, index = 0): Promise<void> {
  if (await page.locator('#lesson-list').isVisible()) await page.locator('#lesson-list button').nth(index).click();
  else {
    await page.getByRole('button', { name: 'Lessons', exact: true }).click();
    await page.locator('#drawer-lessons button').nth(index).click();
  }
}
async function decoded(page: Page): Promise<void> {
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await page.locator('#play-toggle').click();
  await expect
    .poll(() => page.locator('video').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames))
    .toBeGreaterThan(0);
}

test('transient provider503 recovers with bounded HEAD retries and reaches a decoded frame', async ({
  page,
  context,
}) => {
  const state = await installContractFixture(context);
  state.mediaFailures = 1;
  await enterClassroom(page);
  await chooseLesson(page);
  await decoded(page);
  expect(state.mediaProbes).toBe(2);
  expect(state.mediaRequests).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
});

test('a503 during actual video transfer recovers after a successful HEAD probe', async ({ page, context }) => {
  const state = await installContractFixture(context);
  state.failNextMediaGet = true;
  await enterClassroom(page);
  await chooseLesson(page);
  await decoded(page);
  expect(state.mediaProbes).toBeGreaterThanOrEqual(2);
  expect(state.mediaRequests).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
});

test('permanent provider failure stops after three retries and deliberate Retry lesson opens a new session', async ({
  page,
  context,
}) => {
  const state = await installContractFixture(context);
  state.permanentMediaStatus = 503;
  await enterClassroom(page);
  await chooseLesson(page);
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'error', { timeout: 25_000 });
  await expect(page.locator('#ownership-message')).toContainText('saved progress is safe');
  await expect(page.getByRole('button', { name: 'Retry lesson', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Return to course', exact: true })).toBeVisible();
  const requests = state.mediaProbes;
  expect(requests).toBe(4);
  await page.waitForTimeout(1200);
  expect(state.mediaProbes).toBe(requests);
  const previous = state.owner;
  state.permanentMediaStatus = 0;
  await page.getByRole('button', { name: 'Retry lesson', exact: true }).click();
  await decoded(page);
  expect(state.releases).toBeGreaterThan(0);
  expect(state.owner).not.toBe(previous);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
});

test('expired media authorization prompts sign-in without provider retries', async ({ page, context }) => {
  const state = await installContractFixture(context);
  state.permanentMediaStatus = 401;
  await enterClassroom(page);
  await chooseLesson(page);
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'unauthenticated');
  expect(state.mediaProbes).toBe(1);
  expect(state.mediaRequests).toBe(0);
  await page.getByRole('button', { name: 'Sign in again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('switching lessons cancels the old pending media probe and cannot restore the old lesson', async ({
  page,
  context,
}) => {
  const state = await installContractFixture(context);
  state.delayedMediaMs = 2500;
  await enterClassroom(page);
  await chooseLesson(page);
  await expect.poll(() => state.mediaProbes).toBe(1);
  await chooseLesson(page, 1);
  await decoded(page);
  await page.waitForTimeout(2600);
  await expect(page.locator('#lesson-title')).toContainText('Lesson 2');
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'playing');
  expect(state.releases).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
});

test('truncated provider bytes recover and decode through authorized media requests', async ({ page, context }) => {
  const state = await installContractFixture(context);
  state.truncateNextMediaGet = true;
  await enterClassroom(page);
  await chooseLesson(page);
  await decoded(page);
  // WebKit can request a replacement range itself before emitting a media error.
  // Require successful decoding after the bad bytes, without forcing a needless app retry.
  expect(state.mediaProbes).toBeGreaterThanOrEqual(1);
  expect(state.mediaRequests).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
});

test('a stalled transfer times out and recovers without keeping the old media load', async ({ page, context }) => {
  test.setTimeout(60_000);
  const state = await installContractFixture(context);
  state.stallNextMediaGetMs = 24_000;
  await enterClassroom(page);
  await chooseLesson(page);
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready', { timeout: 40_000 });
  await page.locator('#play-toggle').click();
  await expect
    .poll(() => page.locator('video').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames))
    .toBeGreaterThan(0);
  expect(state.mediaProbes).toBeGreaterThanOrEqual(2);
  expect(state.mediaRequests).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
});
