import { expect, test } from '@playwright/test';

test('opens the AR overlay and returns to the keyframe second', async ({ page }) => {
  await page.goto('/spatial-harness.html');
  await expect(page.locator('#lecture-id')).toHaveText('fixture-request-path');
  await expect(page.locator('#spatial-ar-entry')).toBeVisible();
  await expect(page.locator('#spatial-ar-entry')).toContainText('0:24.000');
  await expect(page.locator('.spatial-ar-cite')).toHaveCount(1);

  await page.locator('#spatial-ar-entry').click();
  const dialog = page.locator('#spatial-ar-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.spatial-ar-timestamp')).toHaveText('Lecture timestamp 0:24.000');
  await expect(dialog.locator('model-viewer')).toHaveAttribute('src', '/spatial/scene.gltf');
  await expect(dialog.locator('model-viewer')).toHaveAttribute('ar-placement', 'floor');
  await expect(dialog.locator('.spatial-ar-hotspot')).toHaveText(['API Gateway', 'Auth', 'Orders', 'Queue']);
  await expect(dialog.locator('.spatial-ar-status')).toContainText(/rotate|floor/i);
  await expect(dialog.locator('.spatial-ar-return')).toHaveAttribute('data-seek-seconds', '24');

  await dialog.locator('.spatial-ar-close').click();
  await expect(dialog).toHaveCount(0);

  await page.locator('#lesson-video').evaluate(async (video: HTMLVideoElement) => {
    if (video.readyState < 1) {
      await new Promise<void>(resolve => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
    }
    video.currentTime = 2;
  });
  await expect(page.locator('#spatial-ar-entry')).toBeHidden();
  await expect(page.locator('#playhead')).toHaveText('0:02.000');

  await page.locator('.spatial-ar-cite').click();
  await expect(page.locator('#spatial-ar-dialog')).toBeVisible();
  await page.locator('.spatial-ar-return').click();
  await expect(page.locator('#spatial-ar-dialog')).toHaveCount(0);
  await expect
    .poll(() => page.locator('#lesson-video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(24, 2);
  await expect(page.locator('#playhead')).toHaveText('0:24.000');
  await expect(page.locator('#spatial-ar-entry')).toBeVisible();
});
