import { expect, test, type Page } from '@playwright/test';
import { installContractFixture } from './fixture';

const TOUCH_MIN = 44;

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email address').fill('learner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('CourseForgeDemo2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#catalog')).toBeVisible({ timeout: 20_000 });
}

async function openSurface(page: Page, selector: string) {
  const width = page.viewportSize()!.width;
  if (width <= 1024 && !(await page.locator(selector).isVisible())) {
    await page.locator('#mobile-more-btn').click();
  }
  await page.locator(selector).click();
}

test.describe('mobile and desktop shell fit', () => {
  test.beforeEach(async ({ context }) => {
    await installContractFixture(context);
  });

  test('login controls meet the touch size and the panel stays on screen', async ({ page }) => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 320, height: 640 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/');
      await expect(page.locator('.login-panel')).toBeVisible();
      const box = await page.locator('.login-panel').boundingBox();
      expect(box).toBeTruthy();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      if (viewport.width <= 1024) {
        const show = await page.locator('#toggle-login-password').boundingBox();
        const create = await page.locator('#switch-to-signup').boundingBox();
        expect(show!.height).toBeGreaterThanOrEqual(TOUCH_MIN - 0.5);
        expect(show!.width).toBeGreaterThanOrEqual(TOUCH_MIN - 0.5);
        expect(create!.height).toBeGreaterThanOrEqual(TOUCH_MIN - 0.5);
      }
    }
  });

  test('desktop hides the phone menu and narrow screens keep 44px controls inside the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await expect(page.locator('#mobile-menu-toggle')).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#mobile-menu-toggle')).toBeVisible();
    await openSurface(page, '#nav-planner');
    await expect(page.locator('#planner-panel')).toBeVisible();
    const plannerShort = await page.locator('#planner-panel .planning-tab, #planner-panel .mode-pill, #planner-panel .budget-choice-pill').evaluateAll(nodes =>
      nodes
        .filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
        })
        .filter(el => el.getBoundingClientRect().height < 43.5)
        .map(el => `${el.className} ${Math.round(el.getBoundingClientRect().height)}`),
    );
    expect(plannerShort).toEqual([]);

    await openSurface(page, '#nav-settings');
    await expect(page.locator('.settings-panel-card').first()).toBeVisible();
    const settingsBleed = await page.locator('.settings-panel-card').evaluateAll(nodes =>
      nodes
        .map(el => el.getBoundingClientRect())
        .filter(r => r.width > 0 && (r.left < -1 || r.right > window.innerWidth + 1))
        .map(r => ({ left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth })),
    );
    expect(settingsBleed).toEqual([]);

    await page.setViewportSize({ width: 320, height: 640 });
    const settingsBleedNarrow = await page.locator('.settings-panel-card').evaluateAll(nodes =>
      nodes
        .map(el => el.getBoundingClientRect())
        .filter(r => r.width > 0 && (r.left < -1 || r.right > window.innerWidth + 1))
        .map(r => ({ left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth })),
    );
    expect(settingsBleedNarrow).toEqual([]);
  });

  test('focus classroom stays above the mobile dock and inside the desktop viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await page.getByRole('button', { name: /Open course/ }).first().click();
    await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await page.locator('#focus-dock-toggle').click();
    await expect(page.locator('#classroom')).not.toHaveClass(/dock-collapsed/);

    for (const viewport of [
      { width: 1440, height: 900, dock: 0 },
      { width: 390, height: 844, dock: 64 },
      { width: 320, height: 640, dock: 64 },
    ]) {
      await page.setViewportSize(viewport);
      await page.locator('#classroom').evaluate(el => el.classList.remove('dock-collapsed'));
      await expect(page.locator('#focus-dock')).toBeVisible();
      const boxes = await page.evaluate(() => {
        const rect = (selector: string) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width };
        };
        return {
          player: rect('#player-wrap'),
          title: rect('#lesson-title'),
          dock: rect('#focus-dock'),
          curriculum: rect('#focus-curriculum'),
          search: rect('#focus-search'),
          vw: window.innerWidth,
          vh: window.innerHeight,
        };
      });
      expect(boxes.player).toBeTruthy();
      expect(boxes.dock).toBeTruthy();
      const limit = viewport.height - viewport.dock + 1;
      expect(boxes.player!.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(boxes.player!.left).toBeGreaterThanOrEqual(-1);
      expect(boxes.dock!.bottom).toBeLessThanOrEqual(limit);
      expect(boxes.dock!.height).toBeGreaterThanOrEqual(120);
      expect(boxes.player!.bottom).toBeLessThanOrEqual((boxes.title?.top ?? boxes.dock!.top) + 1);
      if (viewport.width <= 900) {
        expect(boxes.curriculum!.height).toBeGreaterThanOrEqual(TOUCH_MIN - 0.5);
        expect(boxes.search!.height).toBeGreaterThanOrEqual(TOUCH_MIN - 0.5);
      }
      await page.screenshot({
        path: `/opt/cursor/artifacts/shell-${viewport.width}-classroom.png`,
        fullPage: false,
      });
    }
  });
});
