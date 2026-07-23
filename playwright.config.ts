import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the human gameplay path. They drive the real app through
 * the DOM (clicks on `data-testid` handles) — no engine imports, no injected
 * state — so they exercise the same wiring a player does.
 *
 * Games are started with an explicit seed, which makes every roll and shuffle
 * deterministic, so the scripted click sequences are stable across runs.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    video: process.env.CI ? 'retain-on-failure' : 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Test the production bundle: closest to what players get, and it fails the
  // run if the build itself is broken.
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort --host localhost',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
