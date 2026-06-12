import { defineConfig, devices } from '@playwright/test';

/**
 * Photo-framing E2E. Verifies that a product's saved cover framing (focal point +
 * zoom in `cover_crop`) is actually applied — identical object-position / transform —
 * in BOTH the farmer admin (web) and the Пазар Чайка storefront, for portrait photos
 * framed to the top, to the bottom, and centred.
 *
 * Runs against an ALREADY-RUNNING local stack (it does not start it):
 *   - api     http://localhost:3001   (+ postgres `farmflow-postgres-1`, redis `farmflow-redis-1`)
 *   - admin   ADMIN_URL  (default http://localhost:3000)
 *   - chaika  PAZAR_URL  (default http://localhost:4332 — start it with PUBLIC_API_BASE=http://localhost:3001)
 * The spec seeds 3 products straight into Postgres and reverts them afterwards.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { headless: true, viewport: { width: 1280, height: 900 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
