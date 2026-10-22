import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { installContractFixture } from './fixture';

type Problem = { surface: string; width: number; kind: string; detail: string };

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
  if (width <= 1024 && !(await item.isVisible())) await page.locator('#mobile-more-btn').click();
  await item.click();
  await page.keyboard.press('Escape').catch(() => undefined);
  if (width <= 1024) await page.evaluate(() => document.body.classList.remove('mobile-menu-open'));
}

async function inspect(page: Page, surface: string): Promise<Problem[]> {
  const width = page.viewportSize()?.width ?? 1440;
  return page.evaluate(
    ({ surface, width }) => {
      const problems: Problem[] = [];
      const seen = new Set<Element>();
      const roots = new Set<ParentNode>();
      const nodes: HTMLElement[] = [];
      const walk = (root: ParentNode) => {
        if (roots.has(root)) return;
        roots.add(root);
        for (const el of root.querySelectorAll<HTMLElement>('button, [role="button"], *')) {
          if (el.shadowRoot) walk(el.shadowRoot);
          if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') nodes.push(el);
        }
      };
      const box = (el: HTMLElement): DOMRect | null => {
        let next = el.getBoundingClientRect();
        let node = el.parentElement;
        while (node) {
          const style = getComputedStyle(node);
          const clips = [style.overflowX, style.overflowY].some(value => value === 'auto' || value === 'scroll' || value === 'hidden');
          if (clips) {
            const clip = node.getBoundingClientRect();
            const left = Math.max(next.left, clip.left);
            const top = Math.max(next.top, clip.top);
            const right = Math.min(next.right, clip.right);
            const bottom = Math.min(next.bottom, clip.bottom);
            next = new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
          }
          node = node.parentElement;
        }
        const left = Math.max(next.left, 0);
        const top = Math.max(next.top, 0);
        const right = Math.min(next.right, window.innerWidth);
        const bottom = Math.min(next.bottom, window.innerHeight);
        const width = right - left;
        const height = bottom - top;
        if (width < 1 || height < 1) return null;
        return new DOMRect(left, top, width, height);
      };
      const scrollsHorizontally = (el: HTMLElement): boolean => {
        let node = el.parentElement;
        while (node) {
          const style = getComputedStyle(node);
          if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1) return true;
          node = node.parentElement;
        }
        return false;
      };
      walk(document);
      for (const el of nodes) {
        if (seen.has(el)) continue;
        seen.add(el);
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || el.closest('[hidden]')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const visible = box(el);
        const name = (
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60);
        const id = el.id ? `#${el.id}` : name || el.tagName;
        if (!name) problems.push({ surface, width, kind: 'unnamed', detail: id });
        const min = Math.min(rect.width, rect.height);
        if (min < 24) problems.push({ surface, width, kind: 'under-24', detail: `${id} ${Math.round(rect.width)}x${Math.round(rect.height)} ${name}` });
        if (width <= 900 && min < 44 && min >= 24) {
          problems.push({ surface, width, kind: 'under-44', detail: `${id} ${Math.round(rect.width)}x${Math.round(rect.height)} ${name}` });
        }
        if (
          !scrollsHorizontally(el) &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          (rect.left < -1 || rect.right > window.innerWidth + 1)
        ) {
          problems.push({ surface, width, kind: 'offscreen', detail: `${id} L${Math.round(rect.left)} R${Math.round(rect.right)} ${name}` });
        }
        if (visible) {
          const cx = visible.left + visible.width / 2;
          const cy = visible.top + visible.height / 2;
          const top = document.elementFromPoint(cx, cy);
          if (top && top !== el && !el.contains(top) && !top.contains(el)) {
            const cover = top.id ? `#${top.id}` : top.tagName;
            problems.push({ surface, width, kind: 'covered', detail: `${id} covered by ${cover} ${name}` });
          }
        }
        if (el.tagName === 'BUTTON' && !(el as HTMLButtonElement).disabled && !name) {
          problems.push({ surface, width, kind: 'dead-name', detail: id });
        }
      }
      return problems;
    },
    { surface, width },
  );
}

test('audit every visible button', async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(12_000);
  await installContractFixture(page.context());
  const problems: Problem[] = [];
  const clicks: string[] = [];
  page.on('pageerror', error => clicks.push(`pageerror ${error.message}`));

  for (const viewport of [
    { width: 1440, height: 900, label: 'desktop' },
    { width: 390, height: 844, label: 'mobile' },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.context().clearCookies();
    await page.goto('/');
    problems.push(...(await inspect(page, `${viewport.label}-login`)));
    await page.locator('#toggle-login-password').click();
    await expect(page.locator('#password')).toHaveAttribute('type', 'text');
    await page.locator('#switch-to-signup').click();
    await expect(page.locator('#register-form')).toBeVisible();
    problems.push(...(await inspect(page, `${viewport.label}-signup`)));
    await signIn(page);

    const surfaces: Array<[string, string]> = [
      ['home', '#nav-home'],
      ['courses', '#nav-courses'],
      ['saved', '#nav-saved'],
      ['library', '#nav-library'],
      ['planner', '#nav-planner'],
      ['history', '#nav-history'],
      ['reviews', '#nav-reviews'],
      ['tutor', '#nav-tutor'],
      ['labs', '#nav-labs'],
      ['paths', '#nav-paths'],
      ['career', '#nav-career'],
      ['settings', '#nav-settings'],
    ];
    for (const [name, nav] of surfaces) {
      await openNav(page, nav);
      await page.waitForTimeout(200);
      problems.push(...(await inspect(page, `${viewport.label}-${name}`)));
    }

    await openNav(page, '#nav-home');
    if (viewport.width <= 900) {
      await page.locator('#featured-course:not([hidden]) .hero-actions button').first().waitFor({ state: 'visible' });
      const heroFit = await page.evaluate(() => {
        const shell = document.querySelector('.app-layout-shell');
        if (!shell) return [];
        const shellBox = shell.getBoundingClientRect();
        return [...document.querySelectorAll<HTMLElement>('#featured-course .hero-actions button')].map(el => {
          const rect = el.getBoundingClientRect();
          return {
            name: (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim(),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            shellTop: Math.round(shellBox.top),
            shellBottom: Math.round(shellBox.bottom),
            fits: rect.width > 1 && rect.top >= shellBox.top - 1 && rect.bottom <= shellBox.bottom + 1,
          };
        });
      });
      expect(heroFit.filter(item => !item.fits), JSON.stringify(heroFit)).toEqual([]);
    }
    const open = page.getByRole('button', { name: /Open course/ }).first();
    await open.waitFor({ state: 'visible', timeout: 10_000 });
    await open.click();
    await page.locator('#classroom').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('#player-wrap').waitFor({ state: 'visible' });
    await page.locator('#media-controller').evaluate(el => {
      el.setAttribute('autohide', '-1');
      el.removeAttribute('userinactive');
    });
    problems.push(...(await inspect(page, `${viewport.label}-classroom`)));
    const tabs = page.locator('#focus-dock button');
    const count = await tabs.count();
    for (let index = 0; index < count; index += 1) {
      const tab = tabs.nth(index);
      if (!(await tab.isVisible())) continue;
      const label = (await tab.innerText()).trim();
      await tab.click();
      clicks.push(`${viewport.label} dock ${label}`);
    }
    await page.locator('#focus-curriculum').click();
    await page.locator('#back').click();
    if (await page.locator('#logout').isVisible()) await page.locator('#logout').click();
  }

  await writeFile(
    '/opt/cursor/artifacts/button-audit.json',
    JSON.stringify({ problems, clicks, pageErrors: clicks.filter(item => item.startsWith('pageerror')) }, null, 2),
  );
  const serious = problems.filter(item => item.kind === 'unnamed' || item.kind === 'under-24' || item.kind === 'offscreen' || item.kind === 'covered');
  expect(serious, JSON.stringify(serious.slice(0, 20), null, 2)).toEqual([]);
});
