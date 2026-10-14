import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { installContractFixture } from './fixture';

const TOUCH_MIN = 44;

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email address').fill('learner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('CourseForgeDemo2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#catalog')).toBeVisible({ timeout: 20_000 });
}

async function openLesson(page: Page): Promise<void> {
  await login(page);
  await page.getByRole('button', { name: 'Open course' }).click();
  if (await page.locator('#lesson-list').isVisible()) {
    await page.locator('#lesson-list button').first().click();
  } else if (await page.getByRole('button', { name: 'Lessons', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Lessons', exact: true }).click();
    await page.locator('#drawer-lessons button').first().click();
  }
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
}

function isTouchProject(name: string): boolean {
  return /iphone|ipad|mobile/i.test(name);
}

test.describe('responsive layout quality', () => {
  test.beforeEach(async ({ context }) => {
    await installContractFixture(context);
  });

  test('no horizontal scroll, safe-area usage, touch targets, and visual baseline', async ({ page }, testInfo) => {
    test.slow();
    await openLesson(page);

    const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewportMeta || '').toMatch(/viewport-fit\s*=\s*cover/i);

    const scrollOk = await page.evaluate(() => {
      const root = document.scrollingElement || document.documentElement;
      return root.scrollWidth <= window.innerWidth + 1;
    });
    expect(scrollOk).toBe(true);

    const safeAreaUsed = await page.evaluate(() => {
      const samples = [
        document.querySelector('.site-header.lms-top-header'),
        document.querySelector('.player-enhanced media-control-bar') ||
          document.querySelector('#player-wrap media-control-bar'),
        document.querySelector('.app-layout-shell') || document.querySelector('#app'),
      ].filter(Boolean) as HTMLElement[];
      return samples.some(el => {
        const css = getComputedStyle(el);
        const blob = [
          css.paddingTop,
          css.paddingRight,
          css.paddingBottom,
          css.paddingLeft,
          css.height,
          css.minHeight,
        ].join(' ');
        // Tokenized safe-area resolves to 0px without notch, but the declaration must reference env().
        const sheets = [...document.styleSheets];
        for (const sheet of sheets) {
          let rules: CSSRuleList;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          for (const rule of rules) {
            if (!(rule instanceof CSSStyleRule)) continue;
            const text = rule.cssText;
            if (
              text.includes('safe-area-inset') ||
              text.includes('var(--safe-') ||
              text.includes('env(safe-area-inset')
            ) {
              return true;
            }
          }
        }
        return blob.includes('env(') || blob.includes('safe-area');
      });
    });
    expect(safeAreaUsed).toBe(true);

    if (isTouchProject(testInfo.project.name)) {
      const undersized = await page.evaluate(min => {
        const nodes = [
          ...document.querySelectorAll<HTMLElement>(
            'button:not([hidden]), a[href], [role="button"], media-play-button, media-mute-button, .cinema-button, .cinema-settings-btn',
          ),
        ].filter(el => {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          // Skip visually clipped / offscreen chrome that is intentionally sr-only.
          if (el.classList.contains('sr-only-actionable')) return false;
          return rect.width + 0.5 < min || rect.height + 0.5 < min;
        });
        return nodes.slice(0, 12).map(el => ({
          tag: el.tagName.toLowerCase(),
          className: el.className?.toString?.().slice(0, 80) || '',
          w: Math.round(el.getBoundingClientRect().width),
          h: Math.round(el.getBoundingClientRect().height),
        }));
      }, TOUCH_MIN);
      expect(undersized, `undersized touch targets: ${JSON.stringify(undersized)}`).toEqual([]);
    }

    await page.locator('media-controller').evaluate(mc => mc.setAttribute('autohide', '-1'));
    await expect(page).toHaveScreenshot(`shell-${testInfo.project.name}.png`, {
      maxDiffPixelRatio: 0.01,
      fullPage: false,
      animations: 'disabled',
    });
  });

  test('fullscreen and orientation change keep controls usable', async ({ page }, testInfo) => {
    test.slow();
    if (!isTouchProject(testInfo.project.name) && !/desktop-1366|desktop-1920|ipad/i.test(testInfo.project.name)) {
      test.skip();
    }
    await openLesson(page);

    const wrap = page.locator('#player-wrap');
    await wrap.focus();
    await page.evaluate(async () => {
      const el = document.getElementById('player-wrap');
      if (el && !document.fullscreenElement && el.requestFullscreen) {
        try {
          await el.requestFullscreen();
        } catch {
          /* headless may deny; still rotate viewport below */
        }
      }
    });

    // Exit document fullscreen before rotating — Chromium rejects setViewportSize while fullscreen.
    await page.evaluate(async () => {
      if (document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch {
          /* ignore */
        }
      }
    });

    const size = page.viewportSize();
    if (size) {
      await page.setViewportSize({ width: size.height, height: size.width });
    }

    // Re-enter fullscreen after rotation when the API allows it.
    await page.evaluate(async () => {
      const el = document.getElementById('player-wrap');
      if (el && !document.fullscreenElement && el.requestFullscreen) {
        try {
          await el.requestFullscreen();
        } catch {
          /* ignore */
        }
      }
    });

    await page.locator('media-controller').evaluate(mc => mc.setAttribute('autohide', '-1'));
    const play = page.locator('media-play-button, #play-toggle').first();
    await expect(play).toBeVisible();
    const box = await play.boundingBox();
    expect(box).toBeTruthy();
    if (isTouchProject(testInfo.project.name) && box) {
      expect(box.width).toBeGreaterThanOrEqual(TOUCH_MIN - 1);
      expect(box.height).toBeGreaterThanOrEqual(TOUCH_MIN - 1);
    }

    const scrollOk = await page.evaluate(() => {
      const root = document.scrollingElement || document.documentElement;
      return root.scrollWidth <= window.innerWidth + 1;
    });
    expect(scrollOk).toBe(true);

    await expect(page).toHaveScreenshot(`player-rotated-${testInfo.project.name}.png`, {
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
    });
  });
});
