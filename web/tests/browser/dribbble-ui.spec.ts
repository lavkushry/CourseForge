import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installContractFixture } from './fixture';

async function openLesson(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email address').fill('learner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('CourseForgeDemo2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Open course' }).click();
  if (await page.locator('#lesson-list').isVisible()) {
    await page.locator('#lesson-list button').first().click();
  } else {
    await page.getByRole('button', { name: 'Lessons', exact: true }).click();
    await page.locator('#drawer-lessons button').first().click();
  }
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready');
}

test('Desktop: Dribbble 27155177 Theme verification at 1440x900', async ({ page, context }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await installContractFixture(context);
  await openLesson(page);

  // Play and seek video to establish playback and active scrubber position
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('video').evaluate(v => v.currentTime)).toBeGreaterThan(0.5);

  // Seek forward to ~12s
  await page.locator('video').evaluate(v => { v.currentTime = 12.5; });
  await page.waitForTimeout(500);

  // Pin player controls bar visible
  const playerWrap = page.locator('#player-wrap');
  await expect(playerWrap).toBeVisible();
  await page.locator('media-controller').evaluate(mc => mc.setAttribute('autohide', '-1'));
  await playerWrap.hover();
  await page.waitForTimeout(300);

  const playBtn = page.locator('media-play-button');
  await expect(playBtn).toBeVisible();

  const muteBtn = page.locator('media-mute-button');
  await expect(muteBtn).toBeVisible();

  const timeDisplay = page.locator('media-time-display');
  await expect(timeDisplay).toBeVisible();

  const timeline = page.locator('media-time-range');
  await expect(timeline).toBeVisible();

  // Verify Right Controls: Settings, Loop, Popout/Fullscreen
  const settingsBtn = page.locator('.cinema-settings-btn');
  await expect(settingsBtn).toBeVisible();

  const loopBtn = page.locator('button[title*="Loop"]');
  await expect(loopBtn).toBeVisible();

  const fullBtn = page.locator('button[title="Fullscreen"]');
  await expect(fullBtn).toBeVisible();

  // Verify Status Badges & Category Pills below player
  const terracottaPill = page.locator('#lesson-module-badge');
  await expect(terracottaPill).toBeVisible();
  await expect(terracottaPill).toHaveClass(/pill-terracotta/);

  const purplePill = page.locator('#lesson-category-badge');
  await expect(purplePill).toBeVisible();
  await expect(purplePill).toHaveClass(/pill-purple/);

  const emeraldPill = page.locator('#lesson-duration-badge');
  await expect(emeraldPill).toBeVisible();
  await expect(emeraldPill).toHaveClass(/pill-emerald/);

  const oceanPill = page.locator('#coverage');
  await expect(oceanPill).toBeVisible();
  await expect(oceanPill).toHaveClass(/coverage/);

  const saveStatus = page.locator('#save-status');
  await expect(saveStatus).toBeVisible();

  // Capture full classroom and focused player screenshots
  await page.screenshot({ path: 'screenshots/desktop_1440x900_classroom.png', fullPage: false });
  await playerWrap.screenshot({ path: 'screenshots/desktop_player_controls.png' });
});

test('Mobile: Dribbble 27155177 Theme verification at 390x844', async ({ page, context }) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  await installContractFixture(context);
  await openLesson(page);

  // Play video
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('video').evaluate(v => v.currentTime)).toBeGreaterThan(0.5);

  const playerWrap = page.locator('#player-wrap');
  await expect(playerWrap).toBeVisible();

  // Pin player controls bar visible
  await page.locator('media-controller').evaluate(mc => mc.setAttribute('autohide', '-1'));
  await playerWrap.hover();
  await page.waitForTimeout(300);

  // Verify mobile badges
  const badges = page.locator('.lesson-meta-badges');
  await expect(badges).toBeVisible();

  const terracottaPill = page.locator('#lesson-module-badge');
  await expect(terracottaPill).toBeVisible();

  // Capture mobile full screen and player
  await page.screenshot({ path: 'screenshots/mobile_390x844_classroom.png', fullPage: false });
  await playerWrap.screenshot({ path: 'screenshots/mobile_player_controls.png' });
});
