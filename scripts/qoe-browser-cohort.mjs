/**
 * Small Chromium QoE cohort against Vite + Go rewrite (prefer mediasim).
 * Not a 10k / capacity-doc claim.
 *
 * Real auth surface (shell.ts snapshot):
 *   Login:  #email (label "Email"), #password (label "Password"),
 *           #login-form button[type=submit] text "Continue"
 *   Register form: #register-name / #register-email / #register-password
 *   There is NO "Email address" / "Sign in" submit — those labels timeout.
 *
 *   CHROME=... COURSEFORGE_WEB_URL=http://127.0.0.1:5173 N=5 \
 *     node scripts/qoe-browser-cohort.mjs
 */
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

const base = process.env.COURSEFORGE_WEB_URL || 'http://127.0.0.1:5173';
const chrome = process.env.CHROME;
const n = Math.max(1, Math.min(10, Number(process.env.N || 5)));
const outDir = process.env.QOE_OUT || '/home/ubuntu/CourseForge/.ui-evidence/qoe-cohort';
const password = 'CourseForgeDemo2026!';
const forceUiLogin = process.env.QOE_FORCE_UI_LOGIN === '1';

if (!chrome) {
  console.error('CHROME path required');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

/** Live login form — matches shell.ts labels, not Playwright "Email address". */
async function uiSignIn(page, email) {
  await page.locator('#email').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
}

async function openFeatured(page) {
  const candidates = [
    '#featured-course .hero-play',
    '#featured-course button:has-text("Play")',
    'button:has-text("Play")',
    '.continue-card button',
    '.poster-card button',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) && (await loc.isVisible().catch(() => false))) {
      await loc.click({ force: true });
      return sel;
    }
  }
  throw new Error('no featured Play control');
}

async function oneRun(i) {
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const errors = [];
  const httpFails = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', res => {
    if (res.status() >= 500 && res.url().includes('/api/')) {
      httpFails.push(`${res.status()} ${res.url()}`);
    }
  });

  const email = `qoe-cohort-${Date.now()}-${i}@example.test`;
  const t0 = Date.now();
  let authPath = 'api-register-cookie';

  if (forceUiLogin) {
    // Explicit UI path for selector proof (register via API, logout, then #email form).
    const registered = await context.request.post(`${base}/api/v1/auth/register`, {
      headers: { Origin: base },
      data: { email, name: `QoE ${i}`, password },
    });
    if (registered.status() !== 201) {
      throw new Error(`register ${registered.status()} ${await registered.text()}`);
    }
    const me = await context.request.get(`${base}/api/v1/auth/me`);
    const auth = await me.json();
    await context.request.post(`${base}/api/v1/auth/logout`, {
      headers: { Origin: base, 'X-CSRF-Token': auth.csrf_token },
      data: {},
    });
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await uiSignIn(page, email);
    authPath = 'ui-login-#email';
  } else {
    // Preferred: API register shares cookies with the page context.
    const registered = await context.request.post(`${base}/api/v1/auth/register`, {
      headers: { Origin: base },
      data: { email, name: `QoE ${i}`, password },
    });
    if (registered.status() !== 201) {
      throw new Error(`register ${registered.status()} ${await registered.text()}`);
    }
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const homeVisible = await page
      .locator('#featured-course, #catalog, .home-cinema')
      .first()
      .isVisible()
      .catch(() => false);
    if (!homeVisible) {
      await uiSignIn(page, email);
      authPath = 'api-register+ui-fallback-#email';
    }
  }

  await page.waitForSelector('#featured-course, #catalog, .home-cinema', { timeout: 45000 });

  const clickAt = Date.now();
  const clicked = await openFeatured(page);

  const enroll = page.getByRole('button', { name: /Enroll in this course/i });
  if (await enroll.isVisible().catch(() => false)) {
    await enroll.click({ force: true });
  }

  await page.waitForFunction(
    () => {
      const st = document.querySelector('#player-wrap')?.getAttribute('data-state') || '';
      return /ready|playing|paused|buffering|conflict|error/.test(st);
    },
    null,
    { timeout: 45000 },
  );
  if (await page.locator('#move-here').isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Move playback here' }).click({ force: true });
  }
  await page.waitForFunction(
    () => {
      const st = document.querySelector('#player-wrap')?.getAttribute('data-state') || '';
      return /ready|playing|paused|buffering/.test(st);
    },
    null,
    { timeout: 45000 },
  );
  const playerReadyMs = Date.now() - clickAt;
  const playerState = await page.locator('#player-wrap').getAttribute('data-state');

  const video = page.locator('video');
  await video.waitFor({ state: 'attached', timeout: 15000 });
  // Install waiting/stalled + play-wall clocks before deliberate play/seek observation.
  // Rebuffer ratio ≈ waitingMs / (waitingMs + playingMs) after first frame (sampled, not capacity-doc).
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v || v.__cfQoeHooked) return;
    v.__cfQoeHooked = true;
    window.__cfQoe = {
      waiting: 0,
      stalled: 0,
      waitingMs: 0,
      playingMs: 0,
      _waitStart: 0,
      _playStart: 0,
      _obsStart: performance.now(),
    };
    v.addEventListener('waiting', () => {
      window.__cfQoe.waiting += 1;
      if (window.__cfQoe._playStart) {
        window.__cfQoe.playingMs += performance.now() - window.__cfQoe._playStart;
        window.__cfQoe._playStart = 0;
      }
      window.__cfQoe._waitStart = performance.now();
    });
    v.addEventListener('stalled', () => {
      window.__cfQoe.stalled += 1;
    });
    v.addEventListener('playing', () => {
      if (window.__cfQoe._waitStart) {
        window.__cfQoe.waitingMs += performance.now() - window.__cfQoe._waitStart;
        window.__cfQoe._waitStart = 0;
      }
      if (!window.__cfQoe._playStart) {
        window.__cfQoe._playStart = performance.now();
      }
    });
    v.addEventListener('pause', () => {
      if (window.__cfQoe._playStart) {
        window.__cfQoe.playingMs += performance.now() - window.__cfQoe._playStart;
        window.__cfQoe._playStart = 0;
      }
    });
  });
  if (await video.evaluate(v => v.paused).catch(() => true)) {
    const playToggle = page.locator('#play-toggle');
    if (await playToggle.isVisible().catch(() => false)) {
      await playToggle.click({ force: true });
    } else {
      await video.evaluate(v => v.play().catch(() => {}));
    }
  }

  await page.waitForFunction(
    () => {
      const v = document.querySelector('video');
      if (!v) return false;
      const q = v.getVideoPlaybackQuality?.();
      return v.readyState >= 2 && (v.currentTime > 0.05 || (q && q.totalVideoFrames > 0));
    },
    null,
    { timeout: 45000 },
  );
  const firstFrameMs = Date.now() - clickAt;

  const beforeSeek = await video.evaluate(v => v.currentTime);
  await page.locator('#player-wrap').focus();
  await page.keyboard.press('ArrowRight');
  let seekOk = false;
  try {
    await page.waitForFunction(
      t0 => {
        const v = document.querySelector('video');
        return v && v.currentTime > t0 + 0.4;
      },
      beforeSeek,
      { timeout: 12000 },
    );
    seekOk = true;
  } catch {
    seekOk = false;
  }

  // Post-seek hold so waiting/stalled can fire; default longer for formal ratio sample.
  await page.waitForTimeout(process.env.QOE_REBUFFER_HOLD_MS ? Number(process.env.QOE_REBUFFER_HOLD_MS) : 1500);

  const after = await video.evaluate(v => ({
    currentTime: v.currentTime,
    readyState: v.readyState,
    paused: v.paused,
    frames: v.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
    width: v.videoWidth,
    height: v.videoHeight,
    srcHost: (() => {
      try {
        return new URL(v.currentSrc || v.src).host;
      } catch {
        return '';
      }
    })(),
  }));
  const rebuffer = await page.evaluate(() => {
    const q = window.__cfQoe || { waiting: 0, stalled: 0, waitingMs: 0, playingMs: 0 };
    const now = performance.now();
    if (q._waitStart) {
      q.waitingMs += now - q._waitStart;
      q._waitStart = 0;
    }
    if (q._playStart) {
      q.playingMs += now - q._playStart;
      q._playStart = 0;
    }
    const denom = q.waitingMs + q.playingMs;
    q.rebufferRatio = denom > 0 ? q.waitingMs / denom : 0;
    q.observeMs = q._obsStart ? now - q._obsStart : 0;
    return q;
  });

  const shot = path.join(outDir, `run-${i}.png`);
  await page.screenshot({ path: shot, fullPage: false });
  await browser.close();

  // After ArrowRight seek, readyState can briefly be HAVE_METADATA(1) while
  // frames/currentTime already prove decode — count those as success.
  const decoded = (after.frames !== null && after.frames > 0) || after.readyState >= 2;
  const ok = errors.length === 0 && decoded && (seekOk || after.currentTime > 0.05);

  return {
    run: i,
    email,
    authPath,
    clicked,
    playerState,
    totalMs: Date.now() - t0,
    playerReadyMs,
    firstFrameMs,
    seekOk,
    rebuffer,
    after,
    errors,
    httpFails: httpFails.slice(0, 8),
    screenshot: shot,
    ok,
  };
}

const results = [];
for (let i = 1; i <= n; i++) {
  console.log(`qoe run ${i}/${n}`);
  try {
    const r = await oneRun(i);
    results.push(r);
    console.log(
      JSON.stringify({
        run: r.run,
        authPath: r.authPath,
        playerReadyMs: r.playerReadyMs,
        firstFrameMs: r.firstFrameMs,
        seekOk: r.seekOk,
        ok: r.ok,
        playerState: r.playerState,
      }),
    );
  } catch (e) {
    results.push({ run: i, ok: false, error: String(e) });
    console.error(`run ${i} failed`, e);
  }
}

const ok = results.filter(r => r.ok);
const firsts = ok.map(r => r.firstFrameMs).sort((a, b) => a - b);
const readies = ok.map(r => r.playerReadyMs).sort((a, b) => a - b);
const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : null);
const waitingMs = ok.map(r => r.rebuffer?.waitingMs || 0).sort((a, b) => a - b);
const playingMs = ok.map(r => r.rebuffer?.playingMs || 0).sort((a, b) => a - b);
const ratios = ok.map(r => r.rebuffer?.rebufferRatio || 0).sort((a, b) => a - b);
const waitingEvents = ok.map(r => r.rebuffer?.waiting || 0);
const stalledEvents = ok.map(r => r.rebuffer?.stalled || 0);
const summary = {
  plane: 'browser_qoe_sampled',
  stack: 'vite:5173 + api:18090 + media:18094 (prefer mediasim FORCE_SIMULATOR)',
  selectors: {
    email: '#email (label text "Email" — not "Email address")',
    password: '#password (label text "Password")',
    submit: '#login-form button[type=submit] ("Continue")',
    play: '#featured-course .hero-play',
  },
  nRequested: n,
  nOk: ok.length,
  firstFrameMs: firsts.length
    ? { min: firsts[0], p50: firsts[Math.floor(firsts.length / 2)], max: firsts[firsts.length - 1] }
    : null,
  playerReadyMs: readies.length
    ? { min: readies[0], p50: readies[Math.floor(readies.length / 2)], max: readies[readies.length - 1] }
    : null,
  rebuffer: {
    definition:
      'waitingMs / (waitingMs + playingMs) after first frame hooks; excludes intentional pause only if pause event fired; seeks not excluded — sampled mediasim proof, not capacity-doc gate',
    waitingEventsSum: waitingEvents.reduce((a, b) => a + b, 0),
    stalledEventsSum: stalledEvents.reduce((a, b) => a + b, 0),
    waitingMs: waitingMs.length
      ? { min: waitingMs[0], p50: pct(waitingMs, 50), max: waitingMs[waitingMs.length - 1] }
      : null,
    playingMs: playingMs.length
      ? { min: playingMs[0], p50: pct(playingMs, 50), max: playingMs[playingMs.length - 1] }
      : null,
    ratio: ratios.length
      ? { min: ratios[0], p50: pct(ratios, 50), p95: pct(ratios, 95), max: ratios[ratios.length - 1] }
      : null,
  },
  results,
  note: 'Sampled browser cohort only — not capacity-doc 10k / fatal-rate / formal rebuffer-gate proof',
};
const outFile = path.join(outDir, 'summary.json');
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
console.log(
  'SUMMARY',
  JSON.stringify(summary.firstFrameMs),
  JSON.stringify(summary.playerReadyMs),
  JSON.stringify(summary.rebuffer?.ratio),
  `ok=${ok.length}/${n}`,
);
console.log('wrote', outFile);
if (ok.length < Math.ceil(n * 0.6)) process.exit(1);
