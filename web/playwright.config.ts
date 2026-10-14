import { defineConfig, devices } from '@playwright/test';

const screenshotExpect = {
  timeout: 10_000,
  toHaveScreenshot: { maxDiffPixelRatio: 0.01 },
} as const;

export default defineConfig({
  testDir: './tests/browser',
  timeout: 45_000,
  expect: screenshotExpect,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.COURSEFORGE_WEB_URL || 'http://127.0.0.1:5173',
    trace: process.env.PLAYWRIGHT_TRACE ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
    {
      name: 'iphone-14',
      use: { ...devices['iPhone 14'] },
      testMatch: /responsive-layout\.spec\.ts/,
    },
    {
      name: 'ipad-pro-11-portrait',
      use: {
        ...devices['iPad Pro 11'],
        viewport: { width: 834, height: 1194 },
      },
      testMatch: /responsive-layout\.spec\.ts/,
    },
    {
      name: 'ipad-pro-11-landscape',
      use: {
        ...devices['iPad Pro 11 landscape'],
        viewport: { width: 1194, height: 834 },
      },
      testMatch: /responsive-layout\.spec\.ts/,
    },
    {
      name: 'desktop-1366',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1366, height: 768 },
      },
      testMatch: /responsive-layout\.spec\.ts/,
    },
    {
      name: 'desktop-1920',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
      },
      testMatch: /responsive-layout\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'node scripts/dev_staging.mjs',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
  },
});
