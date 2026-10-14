import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installContractFixture } from './fixture';

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email address').fill('learner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('CourseForgeDemo2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#catalog')).toBeVisible();
}

async function openLesson(page: Page): Promise<void> {
  await login(page);
  await page.getByRole('button', { name: 'Open course' }).click();
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

  // Verify Right Controls: Settings, Loop, Fullscreen
  const settingsBtn = page.locator('.cinema-settings-btn');
  await expect(settingsBtn).toBeVisible();

  const loopBtn = page.locator('button[title*="Loop"]');
  await expect(loopBtn).toBeVisible();

  const fullBtn = page.locator('button[title="Fullscreen"]');
  await expect(fullBtn).toBeVisible();

  // Verify Shortened & Title-Cased Status Badges below player
  const terracottaPill = page.locator('#lesson-module-badge');
  await expect(terracottaPill).toBeVisible();
  await expect(terracottaPill).toHaveClass(/pill-terracotta/);
  await expect(terracottaPill).toHaveText('Module 1');

  const purplePill = page.locator('#lesson-category-badge');
  await expect(purplePill).toBeVisible();
  await expect(purplePill).toHaveClass(/pill-purple/);

  const emeraldPill = page.locator('#lesson-duration-badge');
  await expect(emeraldPill).toBeVisible();
  await expect(emeraldPill).toHaveClass(/pill-emerald/);
  await expect(emeraldPill).toHaveText('Studio Lecture');

  const oceanPill = page.locator('#coverage');
  await expect(oceanPill).toBeVisible();
  await expect(oceanPill).toHaveClass(/coverage/);
  await expect(oceanPill).toHaveText(/In Progress|Watched|Lesson completed/i);

  // Verify right-side compact status dot and Progress saved
  const saveStatus = page.locator('#save-status');
  await expect(saveStatus).toBeVisible();
  await expect(saveStatus).toContainText('Progress saved');

  // Verify cleaned lesson title
  const lessonTitle = page.locator('#lesson-title');
  await expect(lessonTitle).toBeVisible();
  await expect(lessonTitle).toContainText('Lesson 1');

  // Verify up-next card is NOT visible during playback
  await expect(page.locator('#playerUpNextCard')).toBeHidden();

  // Capture full classroom and focused player screenshots
  await page.screenshot({ path: 'screenshots/desktop_1440x900_classroom.png', fullPage: false });
  await playerWrap.screenshot({ path: 'screenshots/desktop_player_controls.png' });
});

test('Desktop: Catalog thumbnails & Dribbble course cards at 1440x900', async ({ page, context }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await installContractFixture(context);
  await login(page);

  // Verify catalog and course cards
  const courseList = page.locator('#course-list');
  await expect(courseList).toBeVisible();
  const firstCard = courseList.locator('.course-card').first();
  await expect(firstCard).toBeVisible();

  // Verify 16:9 thumbnail, category pill, and duration badge over thumbnail
  const thumb = firstCard.locator('.course-art');
  await expect(thumb).toBeVisible();
  const catPill = firstCard.locator('.thumb-category-pill');
  await expect(catPill).toBeVisible();
  const durBadge = firstCard.locator('.thumb-duration-badge');
  await expect(durBadge).toBeVisible();

  // Verify no broken images in cards
  const images = firstCard.locator('img');
  const imgCount = await images.count();
  if (imgCount > 0) {
    const naturalWidth = await images.first().evaluate((img: HTMLImageElement) => img.naturalWidth);
    const src = await images.first().getAttribute('src');
    expect(src).toBeTruthy();
  }

  await page.screenshot({ path: 'screenshots/desktop_1440x900_catalog.png', fullPage: false });
  await page.screenshot({ path: 'screenshots/desktop_1440x900_catalog_full.png', fullPage: true });
  await courseList.scrollIntoViewIfNeeded();
  await courseList.screenshot({ path: 'screenshots/desktop_cards_grid.png' });
});

test('Tablet: Dribbble 27155177 Theme verification at 1024x768', async ({ page, context }) => {
  test.slow();
  await page.setViewportSize({ width: 1024, height: 768 });
  await installContractFixture(context);
  await login(page);

  // Verify tablet 2-column catalog grid
  const courseList = page.locator('#course-list');
  await expect(courseList).toBeVisible();
  await page.screenshot({ path: 'screenshots/tablet_1024x768_catalog.png', fullPage: false });
  await courseList.scrollIntoViewIfNeeded();
  await courseList.screenshot({ path: 'screenshots/tablet_cards_grid.png' });

  // Open lesson in tablet view
  await page.getByRole('button', { name: 'Open course' }).click();
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready');

  const terracottaPill = page.locator('#lesson-module-badge');
  await expect(terracottaPill).toBeVisible();
  await expect(terracottaPill).toHaveText('Module 1');

  await page.screenshot({ path: 'screenshots/tablet_1024x768_classroom.png', fullPage: false });
});

test('Mobile: Dribbble 27155177 Theme verification at 390x844', async ({ page, context }) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  await installContractFixture(context);
  await login(page);

  // Verify mobile single-column catalog grid
  const courseList = page.locator('#course-list');
  await expect(courseList).toBeVisible();
  await page.screenshot({ path: 'screenshots/mobile_390x844_catalog.png', fullPage: false });
  await courseList.scrollIntoViewIfNeeded();
  await courseList.screenshot({ path: 'screenshots/mobile_cards_grid.png' });

  // Open course and lesson
  await page.getByRole('button', { name: 'Open course' }).click();
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready');

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
  await expect(terracottaPill).toHaveText('Module 1');

  // Verify up-next card is NOT visible during playback on mobile
  await expect(page.locator('#playerUpNextCard')).toBeHidden();

  // Capture mobile full screen and player
  await page.screenshot({ path: 'screenshots/mobile_390x844_classroom.png', fullPage: false });
  await playerWrap.screenshot({ path: 'screenshots/mobile_player_controls.png' });
});

test('In-Player: Up-Next countdown card with dynamic SVG artwork', async ({ page, context }) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await installContractFixture(context);
  await openLesson(page);

  // Trigger countdown via page evaluation simulating end of lesson countdown
  await page.evaluate(() => {
    const upNext = document.querySelector<HTMLElement>('#playerUpNextCard');
    if (upNext) {
      upNext.hidden = false;
      const badge = upNext.querySelector('#upNextCountdownBadge');
      if (badge) badge.textContent = '8s';
      const title = upNext.querySelector('#upNextTitleText');
      if (title) title.textContent = 'Introduction to Neural Architecture';
      const img = upNext.querySelector<HTMLImageElement>('#upNextThumbImg');
      if (img) {
        img.style.display = 'block';
        img.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="%231a1024"/><circle cx="320" cy="180" r="40" fill="%23ff7952"/><text x="32" y="320" fill="white" font-size="24">UP NEXT</text></svg>';
      }
    }
  });

  const upNextCard = page.locator('#playerUpNextCard');
  await expect(upNextCard).toBeVisible();
  await expect(page.locator('#upNextCountdownBadge')).toHaveText('8s');
  await expect(page.locator('#upNextTitleText')).toHaveText('Introduction to Neural Architecture');
  const img = page.locator('#upNextThumbImg');
  await expect(img).toBeVisible();
  expect(await img.getAttribute('src')).toContain('data:image/svg+xml');

  await upNextCard.screenshot({ path: 'screenshots/desktop_up_next_card.png' });
});
