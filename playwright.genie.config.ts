import { defineConfig } from "@playwright/test";

/**
 * Playwright config for the Genie console's own pages.
 *
 * The console's unit tests run the server and never a browser, and the panel added
 * for Genie's two add-ons proved why that is not enough: it was in the markup, in the
 * rail's tab strip and in `app.js` — which built its rows correctly — while the
 * stylesheet rendered only preview, workspace and publish, so a person opening it saw
 * an empty rail. Every check except a browser said it worked.
 *
 * The instance this boots is the console in its single-operator shape: no control
 * plane, no shared token, loopback trust. That is the shipped default, it needs no
 * fixtures, and what the panel has to prove here — that it opens, lists both add-ons
 * and sends each to its own door — is the same in that shape and in a metered one
 * (the balances themselves are the control-plane tests' business).
 *
 *   npm run test:e2e:genie
 */
const PORT = Number(process.env.ONTRAK_GENIE_E2E_PORT ?? 3466);
const baseURL = process.env.ONTRAK_GENIE_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./ontrak-genie/tests/browser",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { deviceScaleFactor: 1 } }],
  webServer: process.env.ONTRAK_GENIE_E2E_BASE_URL
    ? undefined
    : {
        // Built first: this config exists to test what ships, and the console's own
        // build is what the deployment serves.
        command: [
          "cd ontrak-genie",
          "npm run build >/dev/null",
          `AGENT_WORKSPACE=/tmp/genie-e2e/workspace AGENT_DATA_DIR=/tmp/genie-e2e/.agent PORT=${PORT} node dist/server.js`,
        ].join(" && "),
        url: `${baseURL}/api/auth/status`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        cwd: ".",
      },
});
