import { expect, test } from '@playwright/test';

// This opt-in profile uses only the explicitly seeded isolated rewrite stack.
// It performs real cookie/CSRF/PostgreSQL/gateway calls rather than interception.
test('isolated Go stack: sign in, decoded authorized media, durable note and progress', async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    process.env.COURSEFORGE_BROWSER_STACK !== 'synthetic-rewrite',
    'Start the isolated rewrite stack and set COURSEFORGE_BROWSER_STACK=synthetic-rewrite.',
  );
  // Give each run its own synthetic identity so repeatable UI verification does
  // not consume the seeded learner's legitimate per-account sign-in limit.
  const origin = process.env.COURSEFORGE_WEB_URL || 'http://127.0.0.1:5173';
  const email = `browser-signin-${testInfo.project.name}-${Date.now()}@example.test`;
  const registered = await context.request.post(`${origin}/api/v1/auth/register`, {
    headers: { Origin: origin },
    data: { email, name: 'Synthetic playback learner', password: 'CourseForgeDemo2026!' },
  });
  expect(registered.status()).toBe(201);
  const authResponse = await context.request.get(`${origin}/api/v1/auth/me`);
  expect(authResponse.status()).toBe(200);
  const auth = (await authResponse.json()) as { csrf_token: string };
  const logout = await context.request.post(`${origin}/api/v1/auth/logout`, {
    headers: { Origin: origin, 'X-CSRF-Token': auth.csrf_token },
    data: {},
  });
  expect(logout.ok()).toBe(true);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('CourseForgeDemo2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Open course' }).filter({ hasText: 'Open course' }).first().click();
  await page.getByRole('button', { name: 'Enroll in this course' }).click();
  if (await page.locator('#lesson-list').isVisible()) await page.locator('#lesson-list button').first().click();
  else {
    await page.getByRole('button', { name: 'Lessons', exact: true }).click();
    await page.locator('#drawer-lessons button').first().click();
  }
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', /ready|conflict|error/, { timeout: 30_000 });
  if (await page.locator('#move-here').isVisible())
    await page.getByRole('button', { name: 'Move playback here' }).click();
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  // Start a deliberate sample rather than treating a saved timestamp as proof.
  await page.locator('#autoplay').uncheck();
  await page.locator('#speed').selectOption('1');
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeLessThan(0.5);
  const playbackStarted = Date.now();
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(1);
  await expect
    .poll(() => page.locator('video').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames))
    .toBeGreaterThan(0);
  const decoded = await page.locator('video').evaluate(video => ({
    totalVideoFrames: video.getVideoPlaybackQuality().totalVideoFrames,
    presentedFrames:
      video.getVideoPlaybackQuality().totalVideoFrames - video.getVideoPlaybackQuality().droppedVideoFrames,
    droppedFrames: video.getVideoPlaybackQuality().droppedVideoFrames,
    width: video.videoWidth,
    height: video.videoHeight,
    currentTime: video.currentTime,
    duration: video.duration,
    readyState: video.readyState,
  }));
  await testInfo.attach('decoded-media-sample', {
    body: JSON.stringify({
      project: testInfo.project.name,
      source: 'isolated Go API and separate authenticated media gateway',
      sampleElapsedMs: Date.now() - playbackStarted,
      ...decoded,
    }),
    contentType: 'application/json',
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('authorized-player.png'), fullPage: true });
  await page.locator('#play-toggle').click();
  await expect(page.locator('#save-status')).toHaveText('Progress saved');
  const content = `Browser synthetic note ${Date.now()}`;
  await page.getByLabel('Add a note at the current timestamp').fill(content);
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.locator('#note-list')).toContainText(content);
  await page.getByRole('button', { name: 'Mark as complete', exact: true }).click();
  await expect(page.locator('#coverage')).toHaveText('Lesson completed');
  await page
    .locator('#note-list article')
    .filter({ hasText: content })
    .getByRole('button', { name: 'Delete note' })
    .click();
  await expect(page.locator('#note-list')).not.toContainText(content);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('isolated Go stack: newly registered synthetic learner previews, enrolls and gets private playback', async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    process.env.COURSEFORGE_BROWSER_STACK !== 'synthetic-rewrite',
    'Run only against the explicitly isolated rewrite fixture database.',
  );
  const origin = process.env.COURSEFORGE_WEB_URL || 'http://127.0.0.1:5173';
  const email = `browser-${testInfo.project.name}-${Date.now()}@example.test`;
  const registration = await context.request.post(`${origin}/api/v1/auth/register`, {
    headers: { Origin: origin },
    data: { email, name: 'Synthetic browser learner', password: 'CourseForgeDemo2026!' },
  });
  expect(registration.status()).toBe(201);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open course' }).first().click();
  await expect(page.getByRole('button', { name: 'Enroll in this course' })).toBeVisible();
  await page.getByRole('button', { name: 'Enroll in this course' }).click();
  await expect(page.locator('#course-enrollment')).toBeHidden();
  if (await page.locator('#lesson-list').isVisible()) await page.locator('#lesson-list button').first().click();
  else {
    await page.getByRole('button', { name: 'Lessons', exact: true }).click();
    await page.locator('#drawer-lessons button').first().click();
  }
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await page.locator('#play-toggle').click();
  await expect
    .poll(() => page.locator('video').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames))
    .toBeGreaterThan(0);
  await page.locator('#speed').selectOption('1.5');
  await expect.poll(() => page.locator('video').evaluate(video => video.playbackRate)).toBe(1.5);
  await page.locator('#player-wrap').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(9);
  await page.locator('#play-toggle').click();
  await expect(page.locator('#save-status')).toHaveText('Progress saved');
  const pausedAt = await page.locator('video').evaluate(video => video.currentTime);
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(pausedAt + 0.25);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('isolated Go stack: explicit second-window takeover and offline suspension keep ownership safe', async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    process.env.COURSEFORGE_BROWSER_STACK !== 'synthetic-rewrite',
    'Use the isolated seeded rewrite stack only.',
  );
  const origin = process.env.COURSEFORGE_WEB_URL || 'http://127.0.0.1:5173';
  const registration = await context.request.post(`${origin}/api/v1/auth/register`, {
    headers: { Origin: origin },
    data: {
      email: `browser-lease-${testInfo.project.name}-${Date.now()}@example.test`,
      name: 'Synthetic ownership learner',
      password: 'CourseForgeDemo2026!',
    },
  });
  expect(registration.status()).toBe(201);
  const openLesson = async (current: typeof page, enroll: boolean) => {
    await current.goto('/');
    await current.getByRole('button', { name: 'Open course' }).first().click();
    if (enroll) await current.getByRole('button', { name: 'Enroll in this course' }).click();
    if (await current.locator('#lesson-list').isVisible()) await current.locator('#lesson-list button').first().click();
    else {
      await current.getByRole('button', { name: 'Lessons', exact: true }).click();
      await current.locator('#drawer-lessons button').first().click();
    }
  };
  await openLesson(page, true);
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready');
  await page.locator('#play-toggle').click();
  await expect
    .poll(() => page.locator('video').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames))
    .toBeGreaterThan(0);
  const second = await context.newPage();
  await openLesson(second, false);
  await expect(second.locator('#player-wrap')).toHaveAttribute('data-state', 'conflict');
  await second.getByRole('button', { name: 'Move playback here' }).click();
  await expect(second.locator('#player-wrap')).toHaveAttribute('data-state', 'ready');
  const displacedPulse = page.waitForResponse(response => {
    const path = new URL(response.url()).pathname;
    return path.startsWith('/api/v1/playback/sessions/') && path.endsWith('/pulse');
  });
  await page.locator('#speed').selectOption('1.25');
  const response = await displacedPulse;
  const displacement: unknown = await response.json();
  const data = displacement as { code?: string; owner?: boolean };
  await testInfo.attach('displaced-playback-response', {
    body: JSON.stringify({
      project: testInfo.project.name,
      route: 'POST /api/v1/playback/sessions/:id/pulse',
      status: response.status(),
      code: data.code ?? null,
      owner: data.owner ?? null,
    }),
    contentType: 'application/json',
  });
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'lost');
  await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(true);
  await second.locator('#play-toggle').click();
  await expect
    .poll(() => second.locator('video').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames))
    .toBeGreaterThan(0);
  const displacedPosition = await page.locator('video').evaluate(video => video.currentTime);
  await page.locator('#resume-here').click();
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'conflict');
  await page.getByRole('button', { name: 'Move playback here', exact: true }).click();
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready');
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeCloseTo(displacedPosition, 1);
  await second.locator('#speed').selectOption('1.5');
  await expect(second.locator('#player-wrap')).toHaveAttribute('data-state', 'lost');
  await page.locator('#play-toggle').click();
  await expect
    .poll(() => page.locator('video').evaluate(video => video.currentTime))
    .toBeGreaterThan(displacedPosition + 0.1);
  await context.setOffline(true);
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'suspended');
  await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(true);
  await context.setOffline(false);
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'suspended');
  await page.getByRole('button', { name: 'Resume here', exact: true }).first().click();
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'playing');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('isolated Go stack: discovery search, durable My List and keyboard navigation', async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    process.env.COURSEFORGE_BROWSER_STACK !== 'synthetic-rewrite',
    'Use the isolated seeded rewrite stack only.',
  );
  const origin = process.env.COURSEFORGE_WEB_URL || 'http://127.0.0.1:5173';
  const registration = await context.request.post(`${origin}/api/v1/auth/register`, {
    headers: { Origin: origin },
    data: {
      email: `browser-discovery-${testInfo.project.name}-${Date.now()}@example.test`,
      name: 'Synthetic discovery learner',
      password: 'CourseForgeDemo2026!',
    },
  });
  expect(registration.status()).toBe(201);
  const errors: string[] = [];
  const media: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.resourceType() === 'media') media.push(request.url());
  });
  await page.goto('/');
  await expect(page.locator('#featured-course')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('authorized-discovery.png'), fullPage: true });
  const heroCourse = page.locator('#featured-course');
  const heroTitle = (await heroCourse.locator('.hero-title').textContent()) || 'CourseForge demonstration';
  await heroCourse.getByRole('button', { name: `Save ${heroTitle} to My List` }).click();
  await expect(page.locator('#notice')).toHaveText('Added to My List.');
  await page.getByRole('button', { name: 'My List', exact: true }).click();
  await expect(page.locator('#course-list')).toContainText(heroTitle);
  await page.reload();
  await page.getByRole('button', { name: 'My List', exact: true }).click();
  await expect(page.locator('#course-list')).toContainText(heroTitle);
  await page.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Build your next chapter.' })).toBeVisible();
  await page.getByRole('button', { name: 'Courses', exact: true }).click();
  await page.getByLabel('Search courses').fill('definitely-no-such-synthetic-course');
  await expect(page.getByRole('heading', { name: 'No courses found.' })).toBeVisible();
  await page.getByLabel('Search courses').fill('demonstration');
  await expect(page.locator('#course-list')).toContainText('CourseForge demonstration');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(media).toEqual([]);
  expect(errors).toEqual([]);
});

test('isolated Go stack: revoked sign-in stops playback and opens sign-in recovery', async ({
  page,
  context,
}, testInfo) => {
  test.skip(process.env.COURSEFORGE_BROWSER_STACK !== 'synthetic-rewrite', 'Use the isolated fixture database only.');
  const origin = process.env.COURSEFORGE_WEB_URL || 'http://127.0.0.1:5173';
  const registered = await context.request.post(`${origin}/api/v1/auth/register`, {
    headers: { Origin: origin },
    data: {
      email: `browser-expiry-${testInfo.project.name}-${Date.now()}@example.test`,
      name: 'Synthetic expiry learner',
      password: 'CourseForgeDemo2026!',
    },
  });
  expect(registered.status()).toBe(201);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open course' }).first().click();
  await page.getByRole('button', { name: 'Enroll in this course' }).click();
  if (await page.locator('#lesson-list').isVisible()) await page.locator('#lesson-list button').first().click();
  else {
    await page.getByRole('button', { name: 'Lessons', exact: true }).click();
    await page.locator('#drawer-lessons button').first().click();
  }
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'ready');
  await page.locator('#play-toggle').click();
  await expect
    .poll(() => page.locator('video').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames))
    .toBeGreaterThan(0);
  const authResponse = await context.request.get(`${origin}/api/v1/auth/me`);
  expect(authResponse.status()).toBe(200);
  const auth = (await authResponse.json()) as { csrf_token: string };
  const logout = await context.request.post(`${origin}/api/v1/auth/logout`, {
    headers: { Origin: origin, 'X-CSRF-Token': auth.csrf_token },
    data: {},
  });
  expect(logout.ok()).toBe(true);
  await page.locator('#speed').selectOption('1.25');
  await expect(page.locator('#player-wrap')).toHaveAttribute('data-state', 'unauthenticated');
  await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(true);
  await page.getByRole('button', { name: 'Sign in again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});
