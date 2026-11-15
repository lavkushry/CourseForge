import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

const outRoot = '/home/ubuntu/CourseForge/.ui-evidence/player-focus-v6';
const base = 'https://127.0.0.1:8000';
const chrome = process.env.CHROME;
const password = 'password123';

async function apiRegister() {
  const email = `player.focus.${Date.now()}@courseforge.test`;
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
  // Guarantee immersive watch for the playing shot (lesson pick collapses sheets).
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
}

async function mediaIdentity(page) {
  return page.evaluate(() => {
    const video = document.querySelector('#lesson-video');
    const wrap = document.querySelector('#player-wrap');
    return {
      videoNode: video ? 1 : 0,
      wrapNode: wrap ? 1 : 0,
      src: video?.currentSrc || video?.src || '',
      state: wrap?.getAttribute('data-state') || '',
    };
  });
}

function sameMedia(before, after) {
  return (
    before.videoNode === 1 &&
    after.videoNode === 1 &&
    before.src === after.src &&
    Boolean(before.src) &&
    before.wrapNode === 1 &&
    after.wrapNode === 1 &&
    !['idle', ''].includes(after.state)
  );
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

    const baseline = await mediaIdentity(page);

    // Notes
    await page.locator('#focus-notes').click({ force: true });
    await page.waitForTimeout(700);
    const afterNotes = await mediaIdentity(page);
    report.notesOpen = await page.locator('#classroom').evaluate(el => !el.classList.contains('dock-collapsed'));
    report.notesTab = await page.locator('#focus-dock .focus-dock-tab.active').first().innerText().catch(() => '');
    report.sameMediaNotes = sameMedia(baseline, afterNotes);
    await shot(page, dir, '03-notes-open');
    if (!report.notesOpen || report.notesTab.toLowerCase() !== 'notes' || !report.sameMediaNotes) {
      report.ok = false;
      report.errors.push(
        `notes failed: dock=${report.notesOpen} tab=${report.notesTab} sameMedia=${report.sameMediaNotes}`,
      );
    }

    // Materials
    await page.locator('#focus-materials').click({ force: true });
    await page.waitForTimeout(700);
    const afterMaterials = await mediaIdentity(page);
    report.materialsTab = await page.locator('#focus-dock .focus-dock-tab.active').first().innerText().catch(() => '');
    report.sameMediaMaterials = sameMedia(baseline, afterMaterials);
    await shot(page, dir, '04-materials-open');
    if (report.materialsTab.toLowerCase() !== 'files' || !report.sameMediaMaterials) {
      report.ok = false;
      report.errors.push(
        `files failed: tab=${report.materialsTab} sameMedia=${report.sameMediaMaterials}`,
      );
    }

    // Curriculum / transcript / quiz — at least one one-tap path, lease-safe
    let toolOk = false;
    const tools = [
      {
        name: 'transcript',
        click: '#focus-transcript',
        expectTab: 'transcript',
        shot: '05-transcript-open',
      },
      {
        name: 'quiz',
        click: '#focus-quiz',
        expectTab: 'quiz',
        shot: '06-quiz-open',
      },
      {
        name: 'curriculum',
        click: '#focus-curriculum',
        expectDrawer: true,
        shot: '07-curriculum-open',
      },
    ];
    report.toolChecks = [];
    for (const tool of tools) {
      await page.locator(tool.click).click({ force: true });
      await page.waitForTimeout(700);
      const after = await mediaIdentity(page);
      const same = sameMedia(baseline, after);
      const entry = { name: tool.name, sameMedia: same };
      if (tool.expectTab) {
        entry.tab = await page.locator('#focus-dock .focus-dock-tab.active').first().innerText().catch(() => '');
        entry.ok = same && entry.tab.toLowerCase() === tool.expectTab;
      } else {
        entry.drawerOpen = await page
          .locator('#classroom')
          .evaluate(el => !el.classList.contains('drawer-collapsed'));
        entry.ok = same && entry.drawerOpen === true;
      }
      report.toolChecks.push(entry);
      await shot(page, dir, tool.shot);
      if (entry.ok) toolOk = true;
    }
    report.sameMediaExtra = toolOk;
    if (!toolOk) {
      report.ok = false;
      report.errors.push(`no curriculum/transcript/quiz path stayed lease-safe: ${JSON.stringify(report.toolChecks)}`);
    }

    // Close via Escape — study must not steal focus permanently
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    report.surfacesClosed = await page.locator('#classroom').evaluate(
      el => el.classList.contains('dock-collapsed') && el.classList.contains('drawer-collapsed'),
    );
    await shot(page, dir, '08-closed');
    if (!report.surfacesClosed) {
      // Fallback toggle
      await page.locator('#focus-dock-toggle').click({ force: true }).catch(() => {});
      await page.locator('#focus-curriculum').evaluate(el => {
        if (el.getAttribute('aria-pressed') === 'true') el.click();
      }).catch(() => {});
      await page.waitForTimeout(400);
      report.surfacesClosed = await page.locator('#classroom').evaluate(
        el => el.classList.contains('dock-collapsed') && el.classList.contains('drawer-collapsed'),
      );
      await shot(page, dir, '08-closed');
    }
    if (!report.surfacesClosed) {
      report.ok = false;
      report.errors.push('study surfaces did not close');
    }

    report.sameMedia = report.sameMediaNotes && report.sameMediaMaterials && report.sameMediaExtra;
    report.playerStateAfter = await page.locator('#player-wrap').getAttribute('data-state');
    report.classroomHidden = await page.locator('#classroom').evaluate(el => el.hidden);
    if (report.classroomHidden) {
      report.ok = false;
      report.errors.push('classroom hidden after study tools');
    }

    // Leave classroom — shell chrome must return (site header / nav not stuck hidden)
    await page.locator('#back').click({ force: true }).catch(async () => {
      await page.locator('.back-to-courses-btn').click({ force: true });
    });
    await page.waitForTimeout(900);
    report.shellRestored = await page.evaluate(() => {
      const classroom = document.querySelector('#classroom');
      const header = document.querySelector('.site-header.lms-top-header');
      if (!classroom || !classroom.hidden) return false;
      if (!header) return false;
      return getComputedStyle(header).display !== 'none';
    });
    await shot(page, dir, '09-shell-restored');
    if (!report.shellRestored) {
      report.ok = false;
      report.errors.push('shell chrome did not restore after leaving classroom');
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
const phoneUser = await apiRegister();
const desktopUser = await apiRegister();
console.log('registered', phoneUser.email, desktopUser.email);
const phone = await runViewport('phone', { width: 390, height: 844 }, phoneUser.email);
const desktop = await runViewport('desktop', { width: 1440, height: 900 }, desktopUser.email);
const summary = {
  phoneEmail: phoneUser.email,
  desktopEmail: desktopUser.email,
  assets: {
    js: 'index-DTdAC8bV.js',
    css: 'index-JQEy0pAF.css',
  },
  phone: {
    ok: phone.ok,
    errors: phone.errors,
    playerState: phone.playerState,
    notesTab: phone.notesTab,
    materialsTab: phone.materialsTab,
    sameMedia: phone.sameMedia,
    sameMediaNotes: phone.sameMediaNotes,
    sameMediaMaterials: phone.sameMediaMaterials,
    sameMediaExtra: phone.sameMediaExtra,
    toolChecks: phone.toolChecks,
    shellRestored: phone.shellRestored,
  },
  desktop: {
    ok: desktop.ok,
    errors: desktop.errors,
    playerState: desktop.playerState,
    notesTab: desktop.notesTab,
    materialsTab: desktop.materialsTab,
    sameMedia: desktop.sameMedia,
    sameMediaNotes: desktop.sameMediaNotes,
    sameMediaMaterials: desktop.sameMediaMaterials,
    sameMediaExtra: desktop.sameMediaExtra,
    toolChecks: desktop.toolChecks,
    shellRestored: desktop.shellRestored,
  },
};
fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('SUMMARY', JSON.stringify(summary, null, 2));
if (!phone.ok || !desktop.ok) process.exit(1);
