import { expect, test } from '@playwright/test';
import { installContractFixture } from './fixture';

test.describe('mobile menu sheet', () => {
  test.beforeEach(async ({ context }) => {
    await installContractFixture(context);
  });

  test('opens with full labels, aligned grid and 44px targets', async ({ page }, testInfo) => {
    await page.goto('/');
    await page.getByLabel('Email address').fill('learner@example.test');
    await page.getByLabel('Password', { exact: true }).fill('CourseForgeDemo2026!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#catalog')).toBeVisible({ timeout: 20_000 });

    const toggle = page.locator('#mobile-menu-toggle');
    if (page.viewportSize()!.width > 1024) {
      await expect(toggle).toBeHidden();
      await expect(page.locator('#mobile-nav-backdrop')).toBeHidden();
      return;
    }

    await toggle.click();
    await expect(page.locator('body')).toHaveClass(/mobile-menu-open/);
    await expect(page.locator('#mobile-nav-backdrop')).toBeVisible();
    await expect(page.locator('#mobile-more-btn .lms-nav-label')).toHaveText('Close');

    const items = page.locator('#primary-nav .lms-nav-item:visible');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(9);

    const metrics = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('#primary-nav .lms-nav-item')]
        .filter(el => el.offsetParent !== null)
        .map(el => {
          const label = el.querySelector<HTMLElement>('.lms-nav-label');
          const r = el.getBoundingClientRect();
          return {
            text: label?.textContent?.trim() ?? '',
            overflow: label ? label.scrollWidth > label.clientWidth + 1 : true,
            ellipsis: label ? getComputedStyle(label).textOverflow === 'ellipsis' : true,
            w: r.width,
            h: r.height,
            left: Math.round(r.left),
            right: r.right,
          };
        }),
    );
    for (const m of metrics) {
      expect(m.overflow, `label overflow: ${m.text}`).toBe(false);
      expect(m.ellipsis, `ellipsis on: ${m.text}`).toBe(false);
      expect(m.w, `width ${m.text}`).toBeGreaterThanOrEqual(44);
      expect(m.h, `height ${m.text}`).toBeGreaterThanOrEqual(44);
      expect(m.right).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
    // grid columns are aligned: at most 4 distinct left edges, equal widths
    const lefts = new Set(metrics.map(m => m.left));
    expect(lefts.size).toBeLessThanOrEqual(4);
    const widths = metrics.map(m => m.w);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(2);

    const backdropFilter = await page
      .locator('#mobile-nav-backdrop')
      .evaluate(el => getComputedStyle(el).backdropFilter);
    expect(['none', '']).toContain(backdropFilter);

    await page.screenshot({ path: testInfo.outputPath(`menu-sheet-${testInfo.project.name}.png`) });
    await testInfo.attach('menu-sheet', { body: await page.screenshot(), contentType: 'image/png' });

    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/mobile-menu-open/);
  });
});
