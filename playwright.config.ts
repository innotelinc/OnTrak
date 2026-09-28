import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the browser accessibility sweep.
 *
 * The jsdom audit in `tests/a11y.test.ts` covers structure but cannot evaluate
 * rules that need layout and paint — `color-contrast` above all. This config
 * boots the real app and runs axe-core in Chromium against live pages, so the
 * paint-dependent rules are actually checked.
 *
 *   npm run test:a11y            # boots the app on :3210 and audits it
 *   ONTRAK_A11Y_BASE_URL=... npm run test:a11y   # audit an already-running app
 *
 * The spec skips its signed-in cases when the demo credentials do not work
 * (no database or seed), so the sweep is honest rather than flaky on a bare
 * checkout; the public pages still get audited.
 */
const PORT = Number(process.env.ONTRAK_A11Y_PORT ?? 3210);
const baseURL = process.env.ONTRAK_A11Y_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  // A cold Next dev server compiles each route on first hit; 30s is not enough.
  timeout: 60_000,
  // Assertions wait for a *server-rendered* page to come back, and a dev server
  // with no build cache can take seconds per navigation (longer than the 5s
  // default). The Tix console is the slowest of them, because it renders every
  // incident with its playbook, evidence, timeline and compliance panels.
  expect: { timeout: 20_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.ONTRAK_A11Y_BASE_URL
    ? undefined
    : {
        command: `npx next dev -p ${PORT}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
