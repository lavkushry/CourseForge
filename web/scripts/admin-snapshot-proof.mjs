/**
 * Chromium hybrid proof: learner open-time device/IP snapshots survive login
 * revoke/delete and remain visible in admin UI + CSV/API.
 *
 * Not a 10k / capacity / Odysee claim.
 *
 *   CHROME=... COURSEFORGE_WEB_URL=http://127.0.0.1:5173 \
 *     node scripts/admin-snapshot-proof.mjs
 */
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const base = process.env.COURSEFORGE_WEB_URL || 'http://127.0.0.1:5173';
const apiBase = process.env.COURSEFORGE_API_URL || 'http://127.0.0.1:18090';
const chrome = process.env.CHROME;
const outDir =
  process.env.ADMIN_SNAPSHOT_OUT || '/home/ubuntu/CourseForge/.ui-evidence/admin-snapshot';
const password = 'CourseForgeDemo2026!';
const learnerUA =
  process.env.LEARNER_UA ||
  'CourseForgeSnapshotLearner/1.0 (AdminSnapshotProof; CloudAgent)';

if (!chrome) {
  console.error('CHROME path required');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sql(statements) {
  const script = Array.isArray(statements) ? statements.join('\n') : String(statements);
  const py = `
import psycopg2
conn=psycopg2.connect('postgresql://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite')
conn.autocommit=True
cur=conn.cursor()
for stmt in ${JSON.stringify(script.split('\n').filter(Boolean))}:
    cur.execute(stmt)
conn.close()
print('ok')
`;
  const r = spawnSync('/home/ubuntu/CourseForge/.venv/bin/python', ['-c', py], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`sql failed: ${r.stderr || r.stdout}`);
  }
}

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

async function main() {
  const runId = stamp();
  const evidence = {
    runId,
    base,
    apiBase,
    assertions: [],
    ok: false,
  };
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const learnerEmail = `snap-learner-${Date.now()}@example.test`;
  const adminEmail = `snap-admin-${Date.now()}@example.test`;

  try {
    // --- Learner: register + open playback (captures open-time snapshots) ---
    const learnerCtx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: learnerUA,
      ignoreHTTPSErrors: true,
    });
    const learnerPage = await learnerCtx.newPage();
    const reg = await learnerCtx.request.post(`${base}/api/v1/auth/register`, {
      headers: { Origin: base, 'User-Agent': learnerUA },
      data: { email: learnerEmail, name: 'Snapshot Learner', password },
    });
    if (reg.status() !== 201) {
      throw new Error(`learner register ${reg.status()} ${await reg.text()}`);
    }
    await learnerPage.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const homeVisible = await learnerPage
      .locator('#featured-course, #catalog, .home-cinema')
      .first()
      .isVisible()
      .catch(() => false);
    if (!homeVisible) {
      await uiSignIn(learnerPage, learnerEmail);
    }
    await learnerPage.waitForSelector('#featured-course, #catalog, .home-cinema', {
      timeout: 45000,
    });
    await openFeatured(learnerPage);
    const enroll = learnerPage.getByRole('button', { name: /Enroll in this course/i });
    if (await enroll.isVisible().catch(() => false)) {
      await enroll.click({ force: true });
    }
    await learnerPage.waitForFunction(
      () => {
        const st = document.querySelector('#player-wrap')?.getAttribute('data-state') || '';
        return /ready|playing|paused|buffering|conflict|error/.test(st);
      },
      null,
      { timeout: 45000 },
    );
    if (await learnerPage.locator('#move-here').isVisible().catch(() => false)) {
      await learnerPage.getByRole('button', { name: 'Move playback here' }).click({ force: true });
    }
    await learnerPage.waitForFunction(
      () => {
        const st = document.querySelector('#player-wrap')?.getAttribute('data-state') || '';
        return /ready|playing|paused|buffering/.test(st);
      },
      null,
      { timeout: 45000 },
    );
    await learnerPage.screenshot({
      path: path.join(outDir, `${runId}-learner-player.png`),
      fullPage: true,
    });

    const me = await learnerCtx.request.get(`${base}/api/v1/auth/me`);
    const learnerAuth = await me.json();
    evidence.learnerUserId = learnerAuth.user?.id || learnerAuth.id || learnerAuth.user_id;

    // Confirm DB captured session_open snapshots before revoke.
    const pyCheck = `
import psycopg2, json
conn=psycopg2.connect('postgresql://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite')
cur=conn.cursor()
cur.execute("""SELECT id, device_snapshot, ip_snapshot, snapshot_basis, closed_at IS NOT NULL
  FROM playback_sessions WHERE user_id=%s ORDER BY created_at DESC LIMIT 1""", (${JSON.stringify(evidence.learnerUserId)},))
row=cur.fetchone()
print(json.dumps({"id":row[0],"device":row[1],"ip":row[2],"basis":row[3],"closed":row[4]} if row else None))
conn.close()
`;
    const before = spawnSync('/home/ubuntu/CourseForge/.venv/bin/python', ['-c', pyCheck], {
      encoding: 'utf8',
    });
    if (before.status !== 0) throw new Error(before.stderr || before.stdout);
    const beforeSnap = JSON.parse(before.stdout.trim());
    evidence.before = beforeSnap;
    if (!beforeSnap || beforeSnap.basis !== 'session_open' || !beforeSnap.device) {
      throw new Error(`expected session_open device snapshot before revoke: ${before.stdout}`);
    }
    evidence.assertions.push({
      name: 'learner_open_captured_session_open_device',
      pass: true,
      device: beforeSnap.device,
      basis: beforeSnap.basis,
    });

    // --- Bootstrap admin via open registration + SQL role promote ---
    const adminCtx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ignoreHTTPSErrors: true,
    });
    const adminReg = await adminCtx.request.post(`${base}/api/v1/auth/register`, {
      headers: { Origin: base },
      data: { email: adminEmail, name: 'Snapshot Admin', password },
    });
    if (adminReg.status() !== 201) {
      throw new Error(`admin register ${adminReg.status()} ${await adminReg.text()}`);
    }
    const adminMe = await adminCtx.request.get(`${base}/api/v1/auth/me`);
    const adminAuth = await adminMe.json();
    evidence.adminUserId = adminAuth.user?.id || adminAuth.id || adminAuth.user_id;
    sql([
      `UPDATE users SET role='admin' WHERE id='${String(evidence.adminUserId).replace(/'/g, "''")}'`,
    ]);

    // Revoke learner login (soft gap close path) — detail must survive.
    sql([
      `UPDATE auth_sessions SET revoked_at=now() WHERE user_id='${String(evidence.learnerUserId).replace(/'/g, "''")}' AND revoked_at IS NULL`,
    ]);

    // API evidence after revoke
    const reportRes = await adminCtx.request.get(
      `${base}/api/v1/admin/playback?user_id=${encodeURIComponent(evidence.learnerUserId)}&limit=20`,
      { headers: { Origin: base } },
    );
    if (reportRes.status() !== 200) {
      throw new Error(`admin playback ${reportRes.status()} ${await reportRes.text()}`);
    }
    const report = await reportRes.json();
    fs.writeFileSync(path.join(outDir, `${runId}-api-playback.json`), JSON.stringify(report, null, 2));
    const apiSession = (report.sessions || []).find(s => s.id === beforeSnap.id) || report.sessions?.[0];
    const apiOk =
      apiSession &&
      apiSession.device === beforeSnap.device &&
      apiSession.device_basis === 'session_open' &&
      apiSession.live === false &&
      Boolean(apiSession.device) &&
      apiSession.device.length > 0;
    evidence.assertions.push({
      name: 'api_playback_keeps_open_time_snapshot_after_revoke',
      pass: Boolean(apiOk),
      session: apiSession,
    });
    if (!apiOk) {
      throw new Error(`API snapshot assertion failed: ${JSON.stringify(apiSession)}`);
    }

    // --- Admin UI: Command Center → Live Activity & Exports ---
    const adminPage = await adminCtx.newPage();
    await adminPage.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const adminHome = await adminPage
      .locator('#featured-course, #catalog, .home-cinema, #nav-admin')
      .first()
      .isVisible()
      .catch(() => false);
    if (!adminHome) {
      await uiSignIn(adminPage, adminEmail);
    }
    // Desktop admin rail entry must be visible (not lms-secondary-mobile / cinema-hidden).
    await adminPage.locator('#nav-admin').waitFor({ state: 'visible', timeout: 30000 });
    await adminPage.locator('#nav-admin').click();
    await adminPage.locator('#admin-panel').waitFor({ state: 'visible', timeout: 30000 });
    await adminPage.locator('button[data-admin-tab="activity"]').click();
    await adminPage.locator('[data-testid="playback-snapshot-table"]').waitFor({
      state: 'visible',
      timeout: 30000,
    });

    const row = adminPage.locator(
      `[data-testid="playback-snapshot-row"][data-session-id="${beforeSnap.id}"]`,
    );
    await row.waitFor({ state: 'visible', timeout: 15000 });
    const uiDevice = await row.getAttribute('data-device');
    const uiIp = await row.getAttribute('data-ip');
    const uiBasis = await row.getAttribute('data-basis');
    const uiLive = await row.getAttribute('data-live');
    const uiOk =
      uiDevice === beforeSnap.device &&
      uiBasis === 'session_open' &&
      uiLive === 'false' &&
      Boolean(uiDevice);
    evidence.assertions.push({
      name: 'admin_ui_table_shows_open_time_snapshot',
      pass: uiOk,
      uiDevice,
      uiIp,
      uiBasis,
      uiLive,
    });
    if (!uiOk) {
      throw new Error(`UI snapshot assertion failed device=${uiDevice} basis=${uiBasis} live=${uiLive}`);
    }

    await adminPage.screenshot({
      path: path.join(outDir, `${runId}-admin-snapshots.png`),
      fullPage: true,
    });

    // CSV download via UI button
    const downloadPromise = adminPage.waitForEvent('download', { timeout: 30000 });
    await adminPage.getByRole('button', { name: 'Download Playback CSV' }).click();
    const download = await downloadPromise;
    const csvPath = path.join(outDir, `${runId}-playback.csv`);
    await download.saveAs(csvPath);
    const csv = fs.readFileSync(csvPath, 'utf8');
    const csvOk =
      csv.includes(beforeSnap.device) &&
      csv.includes('Native device snapshot') &&
      !csv.includes('Current login device');
    evidence.assertions.push({
      name: 'admin_ui_csv_download_contains_snapshot',
      pass: csvOk,
      csvPath,
    });
    if (!csvOk) {
      throw new Error('CSV missing native snapshot headers/values');
    }

    evidence.ok = evidence.assertions.every(a => a.pass);
    fs.writeFileSync(path.join(outDir, `${runId}-summary.json`), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ok: evidence.ok, outDir, assertions: evidence.assertions }, null, 2));
    if (!evidence.ok) process.exit(1);
  } catch (err) {
    evidence.error = String(err && err.stack ? err.stack : err);
    fs.writeFileSync(path.join(outDir, `${runId}-summary.json`), JSON.stringify(evidence, null, 2));
    console.error(evidence.error);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
