import { expect, test } from '@playwright/test';

test('student surfaces open a gated spatial view and withhold a held one', async ({ page }) => {
  await page.goto('/spatial-pipeline-harness.html');
  const explore = page.locator('#player .spatial-explore-button');
  await expect(explore).toContainText('Explore in 3D / AR / VR');
  await expect(page.locator('#held .spatial-explore-button')).toHaveCount(0);
  await expect(page.locator('#plan .spatial-plan-note')).toContainText('original lecture video remains the ground truth');

  await explore.click();
  await page.locator('#player').getByRole('menuitem', { name: 'Explore in AR' }).click();
  const dialog = page.locator('dialog.spatial-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('model-viewer')).toHaveAttribute('ar', '');
  await expect(dialog.locator('model-viewer')).toHaveAttribute('ar-placement', 'floor');
  await expect(dialog.locator('model-viewer')).toHaveAttribute(
    'src',
    '/api/v1/lessons/lec-diagram/spatial/model?kind=ar',
  );
  await expect(dialog.locator('.spatial-label')).toHaveText(['API Gateway', 'Auth', 'Orders', 'Queue']);
  await expect(dialog.locator('.spatial-label-warning')).toContainText(
    'AI-generated — verify against original lecture at 0:18',
  );
  await expect(dialog.locator('.spatial-evidence')).toHaveText('API Gateway\nAuth\nOrders\nQueue');
  await page.screenshot({ path: '/opt/cursor/artifacts/spatial-pipeline-ar.png', fullPage: true });
  await dialog.locator('.spatial-return').click();
  await expect(page.locator('#seek')).toHaveText('18');
  await expect(dialog).toBeHidden();

  await explore.click();
  await page.locator('#player').getByRole('menuitem', { name: 'Explore in VR' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.spatial-label-warning')).toHaveCount(0);
  const enter = dialog.locator('.spatial-vr-enter');
  await enter.click();
  await expect(enter).toContainText(/No VR headset|cannot enter VR/);
  await dialog.locator('.spatial-close').click();

  const citation = page.locator('#citations .spatial-explore-button');
  await expect(citation).toBeVisible();
  await citation.click();
  await page.locator('#citations').getByRole('menuitem', { name: 'Explore in 3D' }).click();
  await expect(page.locator('#opened')).toHaveText('3d:18');
  await expect(page.locator('#seek')).toHaveText('18');
});
