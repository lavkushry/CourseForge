import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

const outRoot = '/home/ubuntu/CourseForge/.ui-evidence/player-focus';
const base = 'https://127.0.0.1:8000';
const chrome = process.env.CHROME;
const password = 'password123';

async function apiRegister() {
  const email = `player.focus.${Date.now()}@courseforge.test`;
  // curl ignores the duckdns cert mismatch on 127.0.0.1
  const { execFileSync } = await import('node:child_process');
  const raw = execFileSync(
    'curl',
    [
      '-sk',
      '-X',
      'POST',
      `${base}/api/v1/auth/register`,
      '-H',
      'Content-Type: application/json',
      '-d',
      JSON.stringify({ name: 'Player Focus', email, password }),
    ],
    { encoding: 'utf8' },
  );
  const body = JSON.parse(raw);
  if (!body.session_id) throw new Error(`register failed: ${raw}`);
  return { email, csrf: body.csrf_token, session: body.session_id };
}

async function login(page, email) {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#email, input[type=email]', { timeout: 30000 });
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('#login-form button[type=submit], button[type=submit]');
  await page.waitForSelector('#featured-course, #catalog, #course-list, .home-cinema', {
    timeout: 45000,
  });
}

async function openPlayableLesson(page) {
  // Prefer featured play / continue
  const candidates = [
    '#featured-course .hero-play',
    '#featured-course button:has-text("Play")',
    '#featured-course button:has-text("Continue")',
    '.continue-card button',
    'button:has-text("Continue watching")',
    '.poster-card button',
    '.course-card button:has-text("Play")',
    '.course-card button:has-text("Continue")',
    '.course-card button:has-text("Open")',
  ];
  let clicked = false;
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) && (await loc.isVisible().catch(() => false))) {
      await loc.click({ force: true });
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    const card = page.locator('.course-card, .poster-card').first();
    await card.click({ force: true });
  }
  await page.waitForSelector('#classroom:not([hidden])', { timeout: 45000 });

  for (let i = 0; i < 24; i++) {
    const enrollVisible = await page
      .locator('#course-enrollment')
      .evaluate(el => !el.hasAttribute('hidden') && getComputedStyle(el).display !== 'none')
      .catch(() => false);
    if (enrollVisible) {
      await page.locator('#enroll').click({ force: true });
      await page.waitForTimeout(900);
    }
    const state = await page.locator('#player-wrap').getAttribute('data-state').catch(() => null);
    const title = (await page.locator('#lesson-title').innerText().catch(() => '')).trim();
    if (state === 'ready' || state === 'playing' || state === 'paused') {
      if (!/lesson not found|choose a lesson/i.test(title)) break;
    }
    // Open lessons sheet and pick first lesson if needed
    const curriculum = page.locator('#focus-curriculum');
    if (await curriculum.count()) {
      const pressed = await curriculum.getAttribute('aria-pressed');
      if (pressed !== 'true') await curriculum.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
      const lesson = page
        .locator('#study-rail button.rail-lesson-btn, #study-rail .rail-lesson, #study-rail button[data-lesson-id]')
        .first();
      if ((await lesson.count()) && (await lesson.isVisible().catch(() => false))) {
        await lesson.click({ force: true });
        await page.waitForTimeout(800);
      }
    }
    await page.waitForTimeout(500);
  }

  await page.locator('#play-toggle').click({ force: true }).catch(() => {});
  await page.waitForTimeout(1000);
}

async function shot(page, dir, name) {
  const p = path.join(dir, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log('shot', p);
}

async function runViewport(label, viewport, email) {
  const dir = path.join(outRoot, label);
  fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--ignore-certificate-errors', '--no-sandbox'],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const report = { label, viewport, steps: [], ok: true, errors: [] };
  page.on('pageerror', e => {
    const msg = String(e);
    if (!/WebAssembly|Content Security Policy/i.test(msg)) report.errors.push(msg);
  });

  try {
    await login(page, email);
    report.steps.push('login');
    await shot(page, dir, '01-home');

    await openPlayableLesson(page);
    report.steps.push('opened-classroom');
    await shot(page, dir, '02-playing');

    const enrollHidden = await page
      .locator('#course-enrollment')
      .evaluate(el => el.hasAttribute('hidden') || getComputedStyle(el).display === 'none')
      .catch(() => true);
    const title = await page.locator('#lesson-title').innerText();
    report.title = title;
    report.enrollHidden = enrollHidden;
    report.playerState = await page.locator('#player-wrap').getAttribute('data-state');
    if (/lesson not found/i.test(title)) {
      report.ok = false;
      report.errors.push('Lesson not found');
    }
    if (!enrollHidden) {
      report.ok = false;
      report.errors.push('enroll banner still visible');
    }

    // Open notes
    await page.locator('#focus-notes').click({ force: true });
    await page.waitForTimeout(700);
    const dockOpen = await page.locator('#classroom').evaluate(el => !el.classList.contains('dock-collapsed'));
    report.notesOpen = dockOpen;
    report.notesTab = await page
      .locator('#focus-dock .focus-dock-tab.active')
      .first()
      .innerText()
      .catch(() => '');
    report.notesPressed = await page.locator('#focus-notes').getAttribute('aria-pressed');
    await shot(page, dir, '03-notes-open');
    if (!dockOpen || report.notesTab.toLowerCase() !== 'notes') {
      report.ok = false;
      report.errors.push(`notes failed: dock=${dockOpen} tab=${report.notesTab}`);
    }

    // Open materials without remounting the video element / player wrap
    const identityBefore = await page.evaluate(() => {
      const video = document.querySelector('#lesson-video');
      const wrap = document.querySelector('#player-wrap');
      return {
        videoNode: video ? 1 : 0,
        wrapNode: wrap ? 1 : 0,
        src: video?.currentSrc || video?.src || '',
        state: wrap?.getAttribute('data-state') || '',
      };
    });
    await page.locator('#focus-materials').click({ force: true });
    await page.waitForTimeout(700);
    report.materialsTab = await page
      .locator('#focus-dock .focus-dock-tab.active')
      .first()
      .innerText()
      .catch(() => '');
    const identityAfter = await page.evaluate(() => {
      const video = document.querySelector('#lesson-video');
      const wrap = document.querySelector('#player-wrap');
      return {
        videoNode: video ? 1 : 0,
        wrapNode: wrap ? 1 : 0,
        src: video?.currentSrc || video?.src || '',
        state: wrap?.getAttribute('data-state') || '',
        sameVideoEl: Boolean(video && video.isConnected),
      };
    });
    report.sameMedia =
      identityBefore.videoNode === 1 &&
      identityAfter.videoNode === 1 &&
      identityBefore.src === identityAfter.src &&
      Boolean(identityBefore.src);
    report.playerIntact =
      identityBefore.wrapNode === 1 &&
      identityAfter.wrapNode === 1 &&
      !['idle', ''].includes(identityAfter.state);
    await shot(page, dir, '04-materials-open');
    if (report.materialsTab.toLowerCase() !== 'materials') {
      report.ok = false;
      report.errors.push(`materials tab=${report.materialsTab}`);
    }
    if (!report.sameMedia || !report.playerIntact) {
      report.ok = false;
      report.errors.push(
        `player remounted: sameMedia=${report.sameMedia} intact=${report.playerIntact} state=${identityAfter.state}`,
      );
    }

    // Close
    await page.locator('#focus-dock-toggle').click({ force: true });
    await page.waitForTimeout(500);
    report.dockClosed = await page.locator('#classroom').evaluate(el => el.classList.contains('dock-collapsed'));
    await shot(page, dir, '05-closed');
    if (!report.dockClosed) {
      report.ok = false;
      report.errors.push('dock did not close');
    }

    report.playerStateAfter = await page.locator('#player-wrap').getAttribute('data-state');
    report.classroomHidden = await page.locator('#classroom').evaluate(el => el.hidden);
    if (report.classroomHidden) {
      report.ok = false;
      report.errors.push('classroom hidden after study tools');
    }
  } catch (err) {
    report.ok = false;
    report.errors.push(String(err));
    await shot(page, dir, '99-error').catch(() => {});
  }

  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  return report;
}

fs.mkdirSync(outRoot, { recursive: true });
// Separate learners so phone+desktop evidence do not fight one lease.
const phoneUser = await apiRegister();
const desktopUser = await apiRegister();
console.log('registered', phoneUser.email, desktopUser.email);
const phone = await runViewport('phone', { width: 390, height: 844 }, phoneUser.email);
const desktop = await runViewport('desktop', { width: 1440, height: 900 }, desktopUser.email);
const summary = {
  phoneEmail: phoneUser.email,
  desktopEmail: desktopUser.email,
  assets: {
    js: 'index-DVmasCCb.js',
    css: 'index-CQMeSUV9.css',
  },
  phone: {
    ok: phone.ok,
    errors: phone.errors,
    playerState: phone.playerState,
    notesTab: phone.notesTab,
    materialsTab: phone.materialsTab,
    sameMedia: phone.sameMedia,
  },
  desktop: {
    ok: desktop.ok,
    errors: desktop.errors,
    playerState: desktop.playerState,
    notesTab: desktop.notesTab,
    materialsTab: desktop.materialsTab,
    sameMedia: desktop.sameMedia,
  },
};
fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('SUMMARY', JSON.stringify(summary, null, 2));
if (!phone.ok || !desktop.ok) process.exit(1);
