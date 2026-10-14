import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installContractFixture } from './fixture';

async function openLesson(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email address').fill('learner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('CourseForgeDemo2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Open course' }).click();
  if (!(await page.locator('#lesson-list').isVisible())) await page.locator('#episodes').click();
  await page.locator('#lesson-list:visible button, #drawer-lessons:visible button').first().click();
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready');
}

test('player contains complete controls and a usable separate timeline at every viewport', async ({
  page,
  context,
}) => {
  await installContractFixture(context);
  await openLesson(page);
  const player = page.locator('#player-wrap');
  await player.hover();
  await expect(player.getByLabel('In-player playback speed')).toBeVisible();
  await expect(player.getByRole('button', { name: 'Toggle fullscreen', exact: true })).toBeVisible();
  await expect(player.getByRole('button', { name: 'Course lessons', exact: true })).toBeVisible();
  const timeline = player.locator('media-time-range');
  const width = await timeline.evaluate(node => node.getBoundingClientRect().width);
  const playerWidth = await player.evaluate(node => node.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(playerWidth * 0.85);
  await player.getByLabel('In-player playback speed').selectOption('1.5');
  await expect.poll(() => page.locator('video').evaluate(video => video.playbackRate)).toBe(1.5);
  await expect(page.locator('#speed')).toHaveValue('1.5');
  await player.getByRole('button', { name: 'Course lessons', exact: true }).click();
  await expect(page.locator('#episode-dialog')).toBeVisible();
  expect(await page.locator('#episode-dialog').evaluate(node => Boolean(node.closest('#player-wrap')))).toBe(true);
  await page.locator('#close-episodes').click();
  await expect(player.getByRole('button', { name: 'Course lessons', exact: true })).toBeFocused();
});

test('documented L shortcut seeks forward instead of locking the controls', async ({ page, context }) => {
  await installContractFixture(context);
  await openLesson(page);
  await page.locator('#player-wrap').focus();
  await page.keyboard.press('l');
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(9);
  await expect(page.locator('#unlock-controls')).toBeHidden();
});

test('timeline scrubbing and in-player pause/restart decode real frames without losing controls', async ({
  page,
  context,
}) => {
  await installContractFixture(context);
  await openLesson(page);
  const player = page.locator('#player-wrap');
  await player.getByRole('button', { name: 'Play lesson', exact: true }).click();
  await expect
    .poll(() => page.locator('video').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames))
    .toBeGreaterThan(0);
  await page.locator('#play-toggle').click();
  const timeline = player.locator('media-time-range');
  const box = await timeline.boundingBox();
  if (!box) throw new Error('Timeline must have an interactive rectangle.');
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2);
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(18);
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeLessThan(24);
  await expect(player.locator('.cinema-seek-feedback')).toBeVisible();
  await page.locator('#restart').click();
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeLessThan(0.5);
  await player.getByRole('button', { name: 'Play lesson', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(false);
});

test('fullscreen keeps playback settings and course navigation inside the active player', async ({ page, context }) => {
  await installContractFixture(context);
  await openLesson(page);
  const player = page.locator('#player-wrap');
  const capability = await page.evaluate(() => document.fullscreenEnabled);
  await player.getByRole('button', { name: 'Toggle fullscreen', exact: true }).click();
  if (!capability) {
    // iOS native fullscreen has its own browser UI; desktop-only commands must
    // not pretend the DOM fullscreen API exists on this profile.
    await expect
      .poll(() =>
        page.locator('video').evaluate(video => {
          const native = video as HTMLVideoElement & {
            webkitDisplayingFullscreen?: boolean;
            webkitPresentationMode?: string;
          };
          if (native.webkitDisplayingFullscreen || native.webkitPresentationMode === 'fullscreen') return 'native';
          return /fullscreen/i.test(document.querySelector('#notice')?.textContent || '') ? 'unavailable' : 'pending';
        }),
      )
      .not.toBe('pending');
    return;
  }
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('player-wrap');
  await expect(player.getByLabel('In-player playback speed')).toBeVisible();
  await player.getByLabel('In-player playback speed').selectOption('1.25');
  await expect.poll(() => page.locator('video').evaluate(video => video.playbackRate)).toBe(1.25);
  await player.getByRole('button', { name: 'Course lessons', exact: true }).click();
  await expect(page.locator('#episode-dialog')).toBeVisible();
  await page.locator('#close-episodes').click();
  await expect(player.getByRole('button', { name: 'Course lessons', exact: true })).toBeFocused();
  await player.getByRole('button', { name: 'Toggle fullscreen', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
});
