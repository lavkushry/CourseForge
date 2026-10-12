import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installContractFixture } from './fixture';

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email address').fill('learner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('CourseForgeDemo2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#featured-course')).toBeVisible();
}

test('metadata-only cinematic discovery, responsive geometry and debounced actual catalog search', async ({ page, context }) => {
  await installContractFixture(context);
  const errors: string[] = []; const media: string[] = []; const searches: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.resourceType() === 'media') media.push(request.url()); if (request.url().includes('/public/courses?') && new URL(request.url()).searchParams.has('q')) searches.push(request.url()); });
  await login(page);
  await expect(page.locator('#featured-course')).toContainText('CourseForge demonstration');
  expect(media).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Search courses').fill('not a real title');
  await expect(page.getByRole('heading', { name: 'No courses found.' })).toBeVisible();
  await expect(page.locator('#featured-course')).toBeHidden();
  expect(searches).toHaveLength(1);
  await page.getByLabel('Search courses').fill('demonstration');
  await expect(page.locator('#course-list')).toContainText('CourseForge demonstration');
  expect(media).toEqual([]); expect(errors).toEqual([]);
});

test('My List saves to the server, survives navigation, removes and shows a useful empty state', async ({ page, context }) => {
  await installContractFixture(context); await login(page);
  await page.locator('#featured-course').getByRole('button', { name: 'Save CourseForge demonstration to My List' }).click();
  await expect(page.locator('#notice')).toHaveText('Added to My List.');
  await expect(page.locator('#featured-course').getByRole('button', { name: 'Remove CourseForge demonstration from My List' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'My List', exact: true }).click();
  await expect(page.locator('#catalog-heading')).toHaveText('My List');
  await expect(page.locator('#course-list')).toContainText('CourseForge demonstration');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Build your next chapter.' })).toBeVisible();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.locator('#featured-course').getByRole('button', { name: 'Save CourseForge demonstration to My List' })).toHaveAttribute('aria-pressed', 'false');
});

test('continue learning opens the actual learner lesson; catalog navigation releases playback', async ({ page, context }) => {
  await installContractFixture(context); await login(page);
  await page.getByRole('button', { name: 'Open course' }).click();
  if (await page.locator('#lesson-list').isVisible()) await page.locator('#lesson-list button').first().click();
  else { await page.getByRole('button', { name: 'Lessons', exact: true }).click(); await page.locator('#drawer-lessons button').first().click(); }
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready');
  await page.locator('#player-wrap').focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(10);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.locator('#continue-section')).toBeVisible();
  await page.getByRole('button', { name: 'Resume Lesson 1 — Playback and progress' }).click();
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready');
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(10);
  await page.getByRole('button', { name: 'Courses', exact: true }).click();
  await expect(page.locator('#classroom')).toBeHidden();
  expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);
});

test('keyboard navigation, action focus and reduced motion remain usable', async ({ page, context }) => {
  await installContractFixture(context); await page.emulateMedia({ reducedMotion: 'reduce' }); await login(page);
  await page.getByRole('button', { name: 'Courses', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'My List', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#catalog-heading')).toHaveText('My List');
  await page.getByRole('button', { name: 'Home', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#featured-course')).toBeVisible();
  const save = page.locator('#featured-course').getByRole('button', { name: 'Save CourseForge demonstration to My List' });
  await save.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#featured-course').getByRole('button', { name: 'Remove CourseForge demonstration from My List' })).toBeFocused();
  const card = page.locator('#course-list .course-card').first();
  await card.scrollIntoViewIfNeeded();
  const before = await card.boundingBox(); await card.hover(); await page.waitForTimeout(250);
  const after = await card.boundingBox();
  expect(after?.y).toBe(before?.y);
  await page.getByRole('button', { name: 'Open course' }).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#lesson-title')).toBeFocused();
});
