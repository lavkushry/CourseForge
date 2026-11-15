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
 *   BROWSER=webkit N=1 QOE_OUT=... node scripts/qoe-browser-cohort.mjs
 *     (Playwright cache webkit; CHROME optional/ignored)
 */
import { chromium, webkit } from 'playwright-core';
import fs from 'fs';
import path from 'path';

const base = process.env.COURSEFORGE_WEB_URL || 'http://127.0.0.1:5173';
const chrome = process.env.CHROME;
const browserName = (process.env.BROWSER || 'chromium').toLowerCase();
const browserType = browserName === 'webkit' ? webkit : chromium;
// Stepped cohorts may exceed the old N≤10 cap; capacity-doc full gate wants ≥100.
const n = Math.max(1, Math.min(100, Number(process.env.N || 5)));
const outDir = process.env.QOE_OUT || '/home/ubuntu/CourseForge/.ui-evidence/qoe-cohort';
const password = 'CourseForgeDemo2026!';
const forceUiLogin = process.env.QOE_FORCE_UI_LOGIN === '1';

if (browserName === 'chromium' && !chrome) {
  console.error('CHROME path required for chromium');
  process.exit(2);
}
if (browserName !== 'chromium' && browserName !== 'webkit') {
  console.error(`unsupported BROWSER=${browserName} (chromium|webkit)`);
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
  const launchOpts = {
    headless: true,
  };
  if (browserName === 'chromium') {
    launchOpts.executablePath = chrome;
    launchOpts.args = ['--no-sandbox', '--disable-dev-shm-usage'];
  }
  const browser = await browserType.launch(launchOpts);
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
      // Spatial is optional explore UI; 503 there must not be treated as media death.
      const soft = res.url().includes('/spatial');
      httpFails.push(`${res.status()}${soft ? '[soft]' : ''} ${res.url()}`);
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
  // Capacity-doc sample path excludes seek windows (GO_TYPESCRIPT_CAPACITY.md); still not a 5‑min×100 gate.
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v || v.__cfQoeHooked) return;
    v.__cfQoeHooked = true;
    window.__cfQoe = {
      waiting: 0,
      stalled: 0,
      waitingMs: 0,
      playingMs: 0,
      waitingMsExSeek: 0,
      playingMsExSeek: 0,
      seekWallMs: 0,
      _waitStart: 0,
      _playStart: 0,
      _seekStart: 0,
      _seeking: false,
      _obsStart: performance.now(),
    };
    const qoe = () => window.__cfQoe;
    const flushPlay = now => {
      const q = qoe();
      if (!q._playStart) return;
      const dt = now - q._playStart;
      q.playingMs += dt;
      if (!q._seeking) q.playingMsExSeek += dt;
      q._playStart = 0;
    };
    const flushWait = now => {
      const q = qoe();
      if (!q._waitStart) return;
      const dt = now - q._waitStart;
      q.waitingMs += dt;
      if (!q._seeking) q.waitingMsExSeek += dt;
      q._waitStart = 0;
    };
    v.addEventListener('waiting', () => {
      const q = qoe();
      const now = performance.now();
      q.waiting += 1;
      flushPlay(now);
      if (!q._waitStart) q._waitStart = now;
    });
    v.addEventListener('stalled', () => {
      qoe().stalled += 1;
    });
    v.addEventListener('playing', () => {
      const q = qoe();
      const now = performance.now();
      flushWait(now);
      if (!q._playStart) q._playStart = now;
    });
    v.addEventListener('pause', () => {
      flushPlay(performance.now());
    });
    // Seek windows are reported separately and excluded from ex-seek ratio (capacity-doc).
    v.addEventListener('seeking', () => {
      const q = qoe();
      const now = performance.now();
      if (q._seeking) return;
      flushPlay(now);
      flushWait(now);
      q._seeking = true;
      q._seekStart = now;
    });
    v.addEventListener('seeked', () => {
      const q = qoe();
      const now = performance.now();
      if (q._seekStart) {
        q.seekWallMs += now - q._seekStart;
        q._seekStart = 0;
      }
      q._seeking = false;
      if (!v.paused && !q._playStart) q._playStart = now;
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

  // Capacity-doc ratio starts after first frame. If the element was already playing
  // when hooks installed, the `playing` event will not fire again — arm clocks now.
  await page.evaluate(() => {
    const v = document.querySelector('video');
    const q = window.__cfQoe;
    if (!v || !q) return;
    const now = performance.now();
    q._obsStart = now;
    q.waitingMs = 0;
    q.playingMs = 0;
    q.waitingMsExSeek = 0;
    q.playingMsExSeek = 0;
    q.seekWallMs = 0;
    q.waiting = 0;
    q.stalled = 0;
    q._waitStart = 0;
    q._playStart = 0;
    q._seekStart = 0;
    q._seeking = false;
    if (!v.paused && v.readyState >= 2) {
      q._playStart = now;
    } else if (v.readyState < 3) {
      q._waitStart = now;
    }
  });

  // Steady play after first frame (capacity-doc wants long sessions; this is a short sample window).
  // Poll for empty-video remounts (observed mid-step flake: readyState 0 / empty src after firstFrame).
  const steadyMs = process.env.QOE_STEADY_MS ? Number(process.env.QOE_STEADY_MS) : 8000;
  const sliceMs = 2000;
  let recovered = 0;
  for (let elapsed = 0; elapsed < steadyMs; elapsed += sliceMs) {
    await page.waitForTimeout(Math.min(sliceMs, steadyMs - elapsed));
    const alive = await page.evaluate(() => {
      const v = document.querySelector('video');
      return !!(v && (v.currentSrc || v.src) && v.readyState >= 2 && v.currentTime > 0);
    });
    if (alive) continue;
    recovered += 1;
    // Re-hook clocks on a replacement <video> if the player remounted.
    await page.evaluate(() => {
      const prev = window.__cfQoe || {};
      const v = document.querySelector('video');
      if (!v) return;
      if (v.__cfQoeHooked && window.__cfQoe) return;
      v.__cfQoeHooked = true;
      window.__cfQoe = {
        waiting: prev.waiting || 0,
        stalled: prev.stalled || 0,
        waitingMs: prev.waitingMs || 0,
        playingMs: prev.playingMs || 0,
        waitingMsExSeek: prev.waitingMsExSeek || 0,
        playingMsExSeek: prev.playingMsExSeek || 0,
        seekWallMs: prev.seekWallMs || 0,
        _waitStart: 0,
        _playStart: 0,
        _seekStart: 0,
        _seeking: false,
        _obsStart: prev._obsStart || performance.now(),
        recovered: (prev.recovered || 0) + 1,
      };
      const qoe = () => window.__cfQoe;
      const flushPlay = now => {
        const q = qoe();
        if (!q._playStart) return;
        const dt = now - q._playStart;
        q.playingMs += dt;
        if (!q._seeking) q.playingMsExSeek += dt;
        q._playStart = 0;
      };
      const flushWait = now => {
        const q = qoe();
        if (!q._waitStart) return;
        const dt = now - q._waitStart;
        q.waitingMs += dt;
        if (!q._seeking) q.waitingMsExSeek += dt;
        q._waitStart = 0;
      };
      v.addEventListener('waiting', () => {
        const q = qoe();
        const now = performance.now();
        q.waiting += 1;
        flushPlay(now);
        if (!q._waitStart) q._waitStart = now;
      });
      v.addEventListener('stalled', () => {
        qoe().stalled += 1;
      });
      v.addEventListener('playing', () => {
        const q = qoe();
        const now = performance.now();
        flushWait(now);
        if (!q._playStart) q._playStart = now;
      });
      v.addEventListener('pause', () => {
        flushPlay(performance.now());
      });
      v.addEventListener('seeking', () => {
        const q = qoe();
        const now = performance.now();
        if (q._seeking) return;
        flushPlay(now);
        flushWait(now);
        q._seeking = true;
        q._seekStart = now;
      });
      v.addEventListener('seeked', () => {
        const q = qoe();
        const now = performance.now();
        if (q._seekStart) {
          q.seekWallMs += now - q._seekStart;
          q._seekStart = 0;
        }
        q._seeking = false;
        if (!v.paused && !q._playStart) q._playStart = now;
      });
      if (!v.paused && v.readyState >= 2) {
        window.__cfQoe._playStart = performance.now();
      }
    });
    const playToggle = page.locator('#play-toggle');
    if (await playToggle.isVisible().catch(() => false)) {
      await playToggle.click({ force: true }).catch(() => {});
    } else {
      await page.locator('video').evaluate(v => v.play().catch(() => {})).catch(() => {});
    }
    try {
      await page.waitForFunction(
        () => {
          const v = document.querySelector('video');
          return v && v.readyState >= 2 && v.currentTime > 0.05;
        },
        null,
        { timeout: 15000 },
      );
    } catch {
      // Leave recovery count; final ok check remains fail-closed if still dead.
    }
  }

  // ArrowRight seeks +10s. After long steady on a short fixture (mediasim ≈60s),
  // currentTime may be at EOS so +10 cannot advance — rewind to a safe playhead first.
  // Re-resolve <video> after possible remount during steady.
  const liveVideo = page.locator('video');
  await liveVideo.waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
    const headroom = 15;
    if (v.duration - v.currentTime < headroom) {
      const target = Math.max(0, Math.min(v.duration / 2, v.duration - headroom));
      v.currentTime = target;
    }
    if (v.paused) {
      void v.play().catch(() => {});
    }
  });
  try {
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return (
          v &&
          Number.isFinite(v.duration) &&
          v.duration > 0 &&
          v.duration - v.currentTime >= 12 &&
          !v.seeking
        );
      },
      null,
      { timeout: 8000 },
    );
  } catch {
    // Fall through; seekOk may still fail and be reported honestly.
  }

  const beforeSeek = await liveVideo.evaluate(v => v.currentTime).catch(() => 0);
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

  // Brief post-seek hold (seek wall excluded from ex-seek ratio).
  await page.waitForTimeout(process.env.QOE_REBUFFER_HOLD_MS ? Number(process.env.QOE_REBUFFER_HOLD_MS) : 1500);

  const after = await liveVideo.evaluate(v => ({
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
  })).catch(() => ({
    currentTime: 0,
    readyState: 0,
    paused: true,
    frames: 0,
    width: 0,
    height: 0,
    srcHost: '',
  }));
  const rebuffer = await page.evaluate(() => {
    const q = window.__cfQoe || {
      waiting: 0,
      stalled: 0,
      waitingMs: 0,
      playingMs: 0,
      waitingMsExSeek: 0,
      playingMsExSeek: 0,
      seekWallMs: 0,
      recovered: 0,
    };
    const now = performance.now();
    if (q._seeking && q._seekStart) {
      q.seekWallMs += now - q._seekStart;
      q._seekStart = 0;
      q._seeking = false;
    }
    if (q._waitStart) {
      const dt = now - q._waitStart;
      q.waitingMs += dt;
      if (!q._seeking) q.waitingMsExSeek += dt;
      q._waitStart = 0;
    }
    if (q._playStart) {
      const dt = now - q._playStart;
      q.playingMs += dt;
      if (!q._seeking) q.playingMsExSeek += dt;
      q._playStart = 0;
    }
    const denom = q.waitingMs + q.playingMs;
    const denomEx = q.waitingMsExSeek + q.playingMsExSeek;
    q.rebufferRatio = denom > 0 ? q.waitingMs / denom : 0;
    q.rebufferRatioExSeek = denomEx > 0 ? q.waitingMsExSeek / denomEx : 0;
    q.observeMs = q._obsStart ? now - q._obsStart : 0;
    q.definition =
      'ex-seek: waitingMsExSeek/(waitingMsExSeek+playingMsExSeek); seekWallMs reported separately; sampled ≠ capacity-doc 5min×100 gate';
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
    recovered,
    rebuffer,
    after,
    errors,
    httpFails: httpFails.slice(0, 8),
    screenshot: shot,
    ok,
  };
}

const results = [];
const maxAttempts = process.env.QOE_RETRY_FAIL === '0' ? 1 : 2;
for (let i = 1; i <= n; i++) {
  console.log(`qoe run ${i}/${n}`);
  let r = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      r = await oneRun(i);
      r.attempt = attempt;
      if (r.ok || attempt === maxAttempts) break;
      console.log(JSON.stringify({ run: i, attempt, ok: false, retry: true, seekOk: r.seekOk }));
    } catch (e) {
      r = { run: i, ok: false, error: String(e), attempt };
      if (attempt === maxAttempts) break;
      console.log(JSON.stringify({ run: i, attempt, ok: false, retry: true, error: String(e) }));
    }
  }
  results.push(r);
  console.log(
    JSON.stringify({
      run: r.run,
      authPath: r.authPath,
      playerReadyMs: r.playerReadyMs,
      firstFrameMs: r.firstFrameMs,
      seekOk: r.seekOk,
      recovered: r.recovered,
      attempt: r.attempt,
      ok: r.ok,
      playerState: r.playerState,
    }),
  );
}

const ok = results.filter(r => r.ok);
const firsts = ok.map(r => r.firstFrameMs).sort((a, b) => a - b);
const readies = ok.map(r => r.playerReadyMs).sort((a, b) => a - b);
const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : null);
const waitingMs = ok.map(r => r.rebuffer?.waitingMs || 0).sort((a, b) => a - b);
const playingMs = ok.map(r => r.rebuffer?.playingMs || 0).sort((a, b) => a - b);
const waitingMsEx = ok.map(r => r.rebuffer?.waitingMsExSeek || 0).sort((a, b) => a - b);
const playingMsEx = ok.map(r => r.rebuffer?.playingMsExSeek || 0).sort((a, b) => a - b);
const seekWallMs = ok.map(r => r.rebuffer?.seekWallMs || 0).sort((a, b) => a - b);
const ratios = ok.map(r => r.rebuffer?.rebufferRatio || 0).sort((a, b) => a - b);
const ratiosEx = ok.map(r => r.rebuffer?.rebufferRatioExSeek || 0).sort((a, b) => a - b);
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
      'legacy ratio includes seek waits; ratioExSeek excludes seek windows (capacity-doc alignment sample). Still not 5‑min sessions ×100 / not 10k gate',
    waitingEventsSum: waitingEvents.reduce((a, b) => a + b, 0),
    stalledEventsSum: stalledEvents.reduce((a, b) => a + b, 0),
    waitingMs: waitingMs.length
      ? { min: waitingMs[0], p50: pct(waitingMs, 50), max: waitingMs[waitingMs.length - 1] }
      : null,
    playingMs: playingMs.length
      ? { min: playingMs[0], p50: pct(playingMs, 50), max: playingMs[playingMs.length - 1] }
      : null,
    waitingMsExSeek: waitingMsEx.length
      ? { min: waitingMsEx[0], p50: pct(waitingMsEx, 50), max: waitingMsEx[waitingMsEx.length - 1] }
      : null,
    playingMsExSeek: playingMsEx.length
      ? { min: playingMsEx[0], p50: pct(playingMsEx, 50), max: playingMsEx[playingMsEx.length - 1] }
      : null,
    seekWallMs: seekWallMs.length
      ? { min: seekWallMs[0], p50: pct(seekWallMs, 50), max: seekWallMs[seekWallMs.length - 1] }
      : null,
    ratio: ratios.length
      ? { min: ratios[0], p50: pct(ratios, 50), p95: pct(ratios, 95), max: ratios[ratios.length - 1] }
      : null,
    ratioExSeek: ratiosEx.length
      ? { min: ratiosEx[0], p50: pct(ratiosEx, 50), p95: pct(ratiosEx, 95), max: ratiosEx[ratiosEx.length - 1] }
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
  'legacy',
  JSON.stringify(summary.rebuffer?.ratio),
  'ex_seek',
  JSON.stringify(summary.rebuffer?.ratioExSeek),
  `ok=${ok.length}/${n}`,
);
console.log('wrote', outFile);
if (ok.length < Math.ceil(n * 0.6)) process.exit(1);
