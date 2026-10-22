import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installContractFixture } from './fixture';

async function openLesson(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email address').fill('learner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('CourseForgeDemo2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#catalog')).toBeVisible();
  await page.getByRole('button', { name: 'Open course' }).click();
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready');
}

test('focus classroom keeps the title and dock on screen', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installContractFixture(context);
  await openLesson(page);

  await expect(page.locator('#notice')).toBeHidden();
  await expect(page.locator('#lesson-title')).toBeVisible();
  await expect(page.locator('#focus-dock')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Transcript' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Notes' })).toBeVisible();

  const boxes = await page.evaluate(() => {
    const rect = (id: string) => {
      const node = document.querySelector(id);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    return {
      player: rect('#player-wrap'),
      title: rect('#lesson-title'),
      dock: rect('#focus-dock'),
      rail: rect('#study-rail'),
      viewport: window.innerHeight,
    };
  });
  expect(boxes.player).not.toBeNull();
  expect(boxes.title).not.toBeNull();
  expect(boxes.dock).not.toBeNull();
  expect(boxes.rail).not.toBeNull();
  expect(boxes.player!.bottom).toBeLessThanOrEqual(boxes.title!.top + 1);
  expect(boxes.title!.bottom).toBeLessThanOrEqual(boxes.dock!.top + 1);
  expect(boxes.dock!.bottom).toBeLessThanOrEqual(boxes.viewport + 1);
  expect(boxes.dock!.height).toBeGreaterThanOrEqual(160);
  expect(boxes.rail!.width).toBeGreaterThanOrEqual(300);
  expect(boxes.rail!.width).toBeLessThanOrEqual(340);
  expect(boxes.player!.width / boxes.player!.height).toBeGreaterThan(1.7);
  expect(boxes.player!.width / boxes.player!.height).toBeLessThan(1.85);

  await page.screenshot({ path: '/opt/cursor/artifacts/classroom-structure.png', fullPage: false });
});
