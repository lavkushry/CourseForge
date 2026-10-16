import { expect, test, type Page } from '@playwright/test';
import { installContractFixture } from './fixture';

type Box = { id: string; left: number; right: number; top: number; bottom: number };

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email address').fill('learner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('CourseForgeDemo2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#catalog')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.hero-play').first()).toBeVisible({ timeout: 15_000 });
}

function overlaps(a: Box, b: Box) {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

async function assertHeaderAndNavFit(page: Page) {
  const viewport = page.viewportSize()!;

  // Home hero CTAs ("Continue course" etc.): text stays inside its button.
  const ctas = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.hero-actions > .button')]
      .filter(el => el.getBoundingClientRect().width > 0)
      .map(el => {
        const r = el.getBoundingClientRect();
        return {
          text: el.textContent?.trim() ?? '',
          overflow: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
          left: r.left,
          right: r.right,
          h: r.height,
        };
      }),
  );
  expect(ctas.length, 'hero CTAs rendered').toBeGreaterThan(0);
  for (const cta of ctas) {
    expect(cta.overflow, `hero CTA text overflows: ${cta.text}`).toBe(false);
    expect(cta.left, `hero CTA off-screen: ${cta.text}`).toBeGreaterThanOrEqual(-0.5);
    expect(cta.right, `hero CTA off-screen: ${cta.text}`).toBeLessThanOrEqual(viewport.width + 0.5);
    if (viewport.width <= 1024) expect(cta.h, `hero CTA touch target: ${cta.text}`).toBeGreaterThanOrEqual(44);
  }

  const labels = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#primary-nav .lms-nav-item .lms-nav-label')]
      .filter(el => el.offsetParent !== null && el.getBoundingClientRect().width > 0)
      .filter(el => getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none')
      .map(el => ({
        text: el.textContent?.trim() ?? '',
        overflow: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
        ellipsis: getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth,
        right: el.getBoundingClientRect().right,
      })),
  );
  for (const label of labels) {
    expect(label.overflow, `label clipped: ${label.text}`).toBe(false);
    expect(label.ellipsis, `label ellipsised: ${label.text}`).toBe(false);
    expect(label.right, `label off-screen: ${label.text}`).toBeLessThanOrEqual(viewport.width + 0.5);
  }

  const boxes = await page.evaluate(() => {
    const header = document.querySelector('.site-header')!;
    return [
      ...header.querySelectorAll<HTMLElement>(
        '.brand-wordmark, .brand .lms-floral-mark, button, .lms-header-search, .account-avatar, #account-name',
      ),
    ]
      .filter(el => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return (
          r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]')
        );
      })
      .filter(el => !el.classList.contains('brand'))
      .map(el => {
        const r = el.getBoundingClientRect();
        return { id: el.id || el.className, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
  });
  const wordmark = boxes.find(b => b.id.includes('brand-wordmark'));
  for (let i = 0; i < boxes.length; i++) {
    expect(boxes[i].left, `${boxes[i].id} off left`).toBeGreaterThanOrEqual(-0.5);
    expect(boxes[i].right, `${boxes[i].id} off right`).toBeLessThanOrEqual(viewport.width + 0.5);
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxes[j].id.includes('lms-floral-mark') || boxes[i].id.includes('lms-floral-mark')) continue;
      expect(overlaps(boxes[i], boxes[j]), `${boxes[i].id} overlaps ${boxes[j].id}`).toBe(false);
    }
  }
  if (wordmark) {
    const clipped = await page.locator('.brand-wordmark').evaluate(el => el.scrollWidth > el.clientWidth + 1);
    expect(clipped, 'wordmark clipped').toBe(false);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
}

test.describe('header and bottom navigation fit', () => {
  test.beforeEach(async ({ context }) => {
    await installContractFixture(context);
  });

  test('nav labels are never truncated and header controls never overlap', async ({ page }, testInfo) => {
    await signIn(page);
    await assertHeaderAndNavFit(page);
    await page.screenshot({ path: testInfo.outputPath(`header-nav-${testInfo.project.name}.png`) });

    // Phones: also hold at the narrowest supported width (320px, iPhone SE 1st gen).
    if (page.viewportSize()!.width <= 430) {
      await page.setViewportSize({ width: 320, height: 640 });
      await assertHeaderAndNavFit(page);
    }
  });
});
