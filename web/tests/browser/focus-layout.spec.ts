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

  // Immersive watch starts with the curriculum closed; open it for rail geometry checks.
  await expect(page.locator('#classroom')).toHaveClass(/drawer-collapsed/);
  await page.locator('#focus-curriculum').click();
  await expect(page.locator('#classroom')).not.toHaveClass(/drawer-collapsed/);
  await expect(page.locator('#study-rail')).toBeVisible();

  const boxes = await page.evaluate(() => {
    const rect = (id: string) => {
      const node = document.querySelector(id);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        width: box.width,
        height: box.height,
      };
    };
    const input = document.querySelector('#header-quick-search');
    const shortcut = document.querySelector('.omni-shortcut-kbd');
    const inputBox = input?.getBoundingClientRect();
    const shortcutBox = shortcut?.getBoundingClientRect();
    return {
      player: rect('#player-wrap'),
      stage: rect('.lesson-stage'),
      title: rect('#lesson-title'),
      meta: rect('.lesson-meta-bar'),
      dock: rect('#focus-dock'),
      rail: rect('#study-rail'),
      column: rect('.lesson-column'),
      classroom: rect('#classroom'),
      viewport: window.innerHeight,
      viewportWidth: window.innerWidth,
      searchInputRight: inputBox?.right ?? null,
      searchShortcutLeft: shortcutBox?.left ?? null,
      searchInputWidth: inputBox?.width ?? null,
    };
  });
  expect(boxes.player).not.toBeNull();
  expect(boxes.stage).not.toBeNull();
  expect(boxes.title).not.toBeNull();
  expect(boxes.meta).not.toBeNull();
  expect(boxes.dock).not.toBeNull();
  expect(boxes.rail).not.toBeNull();
  expect(boxes.column).not.toBeNull();
  expect(boxes.classroom).not.toBeNull();
  expect(boxes.player!.bottom).toBeLessThanOrEqual(boxes.title!.top + 1);
  expect(boxes.title!.bottom).toBeLessThanOrEqual(boxes.dock!.top + 1);
  expect(boxes.dock!.bottom).toBeLessThanOrEqual(boxes.viewport + 1);
  expect(boxes.dock!.height).toBeGreaterThanOrEqual(120);
  expect(boxes.rail!.width).toBeGreaterThanOrEqual(300);
  expect(boxes.rail!.width).toBeLessThanOrEqual(340);
  expect(Math.abs(boxes.player!.left - boxes.stage!.left)).toBeLessThanOrEqual(2);
  expect(Math.abs(boxes.player!.right - boxes.stage!.right)).toBeLessThanOrEqual(2);
  expect(Math.abs(boxes.player!.top - boxes.stage!.top)).toBeLessThanOrEqual(2);
  expect(Math.abs(boxes.player!.bottom - boxes.stage!.bottom)).toBeLessThanOrEqual(2);
  expect(Math.abs(boxes.player!.left - boxes.meta!.left)).toBeLessThanOrEqual(2);
  expect(Math.abs(boxes.player!.right - boxes.meta!.right)).toBeLessThanOrEqual(2);
  expect(Math.abs(boxes.player!.left - boxes.dock!.left)).toBeLessThanOrEqual(2);
  expect(Math.abs(boxes.player!.right - boxes.dock!.right)).toBeLessThanOrEqual(2);
  expect(Math.abs(boxes.player!.width - boxes.column!.width)).toBeLessThanOrEqual(2);
  expect(boxes.player!.height).toBeGreaterThanOrEqual((boxes.column!.width * 9) / 16 * 0.75);
  expect(boxes.dock!.bottom).toBeGreaterThanOrEqual(boxes.viewport - 8);
  expect(Math.abs(boxes.rail!.top - boxes.column!.top)).toBeLessThanOrEqual(2);
  expect(Math.abs(boxes.rail!.bottom - boxes.column!.bottom)).toBeLessThanOrEqual(2);
  expect(boxes.classroom!.left).toBeGreaterThanOrEqual(80);
  expect(boxes.classroom!.left).toBeLessThanOrEqual(84);
  expect(boxes.classroom!.right).toBeGreaterThanOrEqual(boxes.viewportWidth - 2);
  expect(boxes.searchInputWidth).not.toBeNull();
  expect(boxes.searchInputWidth!).toBeGreaterThanOrEqual(110);
  expect(boxes.searchShortcutLeft!).toBeGreaterThanOrEqual(boxes.searchInputRight! - 1);

  await page.screenshot({ path: '/opt/cursor/artifacts/classroom-structure.png', fullPage: false });
});
