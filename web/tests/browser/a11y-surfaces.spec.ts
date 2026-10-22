import { expect, test, type Page } from '@playwright/test';
import { installContractFixture } from './fixture';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email address').fill('learner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('CourseForgeDemo2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#catalog')).toBeVisible({ timeout: 20_000 });
}

async function openNav(page: Page, selector: string) {
  const width = page.viewportSize()?.width ?? 1440;
  const item = page.locator(selector);
  if (width <= 1024 && !(await item.isVisible())) {
    await page.locator('#mobile-more-btn').click();
  }
  await item.click();
  if (width <= 1024) {
    await page.evaluate(() => document.body.classList.remove('mobile-menu-open'));
  }
}

test.describe('accessible mobile and desktop surfaces', () => {
  test.beforeEach(async ({ context }) => {
    await installContractFixture(context);
  });

  test('login exposes a skip link, a 44px password control, and a visible focus ring', async ({ page }) => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 320, height: 640 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/');
      const panel = page.locator('.login-panel');
      await expect(panel).toBeVisible();
      const box = await panel.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      const show = await page.locator('#toggle-login-password').boundingBox();
      expect(show!.height).toBeGreaterThanOrEqual(43.5);
      expect(show!.width).toBeGreaterThanOrEqual(43.5);
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.keyboard.press('Tab');
    await expect(page.locator('.skip-link')).toBeFocused();
    const outline = await page.locator('.skip-link').evaluate(el => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
  });

  test('signed-in pages keep one heading, named controls, and the viewport', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 320, height: 640 },
    ]) {
      await page.setViewportSize(viewport);
      const surfaces: Array<[string, string, string]> = [
        ['home', '#nav-home', '#catalog'],
        ['planner', '#nav-planner', '#planner-panel'],
        ['paths', '#nav-paths', '#paths-panel'],
        ['labs', '#nav-labs', '#labs-panel'],
        ['career', '#nav-career', '#career-panel'],
        ['settings', '#nav-settings', '#settings-panel'],
      ];
      for (const [name, nav, panel] of surfaces) {
        await openNav(page, nav);
        await expect(page.locator(panel)).toBeVisible();
        await expect(page.locator(`${panel} h1`).first()).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${name} ${viewport.width}`).toBeLessThanOrEqual(1);
        const bleed = await page.locator('header button, header a, header input').evaluateAll(nodes =>
          nodes
            .map(el => {
              const r = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              if (style.display === 'none' || r.width < 1) return null;
              if (r.left < -1 || r.right > window.innerWidth + 1) {
                return `${el.id || el.className} ${Math.round(r.left)}-${Math.round(r.right)}`;
              }
              return null;
            })
            .filter(Boolean),
        );
        expect(bleed, `${name} header ${viewport.width}`).toEqual([]);
      }

      if (viewport.width <= 900) {
        const short = await page.locator('header button, #primary-nav .lms-nav-item').evaluateAll(nodes =>
          nodes
            .filter(el => {
              const r = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              return style.display !== 'none' && r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
            })
            .filter(el => {
              const r = el.getBoundingClientRect();
              return Math.min(r.width, r.height) < 43.5;
            })
            .map(el => {
              const r = el.getBoundingClientRect();
              return `${el.id || el.getAttribute('aria-label') || el.textContent?.trim()} ${Math.round(r.width)}x${Math.round(r.height)}`;
            }),
        );
        expect(short, `touch targets ${viewport.width}`).toEqual([]);
      }
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await openNav(page, '#nav-settings');
    await expect(page.getByLabel('Daily Goal Duration')).toBeVisible();
    await openNav(page, '#nav-labs');
    await expect(page.getByRole('textbox', { name: /starter code/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Home', exact: true }).first()).toBeVisible();
    const searchName = await page.locator('#header-quick-search-wrap').evaluate(el => el.getAttribute('aria-label'));
    expect(searchName).toBe('Search');

    await openNav(page, '#nav-home');
    await page.getByRole('button', { name: /Open course/ }).first().click();
    await expect(page.locator('#classroom')).toBeVisible();
    await expect(page.locator('#focus-dock')).toBeVisible();
    const classroomOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(classroomOverflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: '/opt/cursor/artifacts/a11y-desktop-classroom.png', fullPage: false });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/opt/cursor/artifacts/a11y-mobile-classroom.png', fullPage: false });
    await openNav(page, '#nav-home');
    await page.screenshot({ path: '/opt/cursor/artifacts/a11y-mobile-home.png', fullPage: false });
  });
});
