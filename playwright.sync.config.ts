/**
 * Playwright config for the Ontrak Sync dashboard.
 *
 * The root `playwright.config.ts` audits the training app, and its `webServer` boots
 * the *training* app — so a Sync spec cannot live under it without booting a product
 * that has nothing to do with what it is checking. This is the second config, and the
 * same reason `npm run test:e2e:tix` exists.
 *
 * **Both halves are started here, and one of them is a fake.** The dashboard is booted
 * with `next dev` like any other dev server. The API is booted by
 * `backend/tests/serve_fake.py`: the real application, over a throwaway database, with
 * `ssh`/`incus exec`/`docker` faked — because a runner has no Network and a browser
 * spec that can only assert "there is nothing to roll" proves nothing about the page.
 * With both owned by this file, `npm run test:e2e:sync` is the whole command.
 *
 * The ports are 8450/8451 rather than the product's 8420/8421 on purpose. A deployment
 * host runs the family stack on the real pair, and `reuseExistingServer` against a
 * *real* API would attach the suite to a Network with no fake host on it — a failure
 * that reads as a broken page rather than as the wrong server.
 *
 * The dashboard is told to keep the API same-origin (`NEXT_PUBLIC_ONTRAK_API` empty,
 * `ONTRAK_API_INTERNAL` pointing at the harness), which is the arrangement the family
 * stack ships: the browser talks only to the dashboard, the Next route handler forwards
 * `/api/*`, and the session is a cookie on one hostname. That means the spec also
 * covers the proxy bridge, which a cross-origin build would skip entirely.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.ONTRAK_SYNC_PORT ?? 8451);
const API_PORT = Number(process.env.ONTRAK_SYNC_API_PORT ?? 8450);
const baseURL = process.env.ONTRAK_SYNC_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: /sync\.spec\.ts$/,
  // One worker: the spec claims a remit, rolls it and gives it back, and two of these
  // running at once would be two writers on one database.
  fullyParallel: false,
  workers: 1,
  // A cold Turbopack dev server compiles each route the first time it is asked for, and
  // the rollouts page pulls four endpoints through a Python process on the first hit.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "python3 ontrak-sync/backend/tests/serve_fake.py",
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ONTRAK_FAKE_PORT: String(API_PORT),
        // The API refuses to start without a token, and this one reaches nothing: the
        // host is faked, so the credential never leaves the machine.
        ONTRAK_API_TOKEN: process.env.ONTRAK_API_TOKEN ?? "ci-only-not-a-production-secret",
        ONTRAK_ADMIN_USER: process.env.ONTRAK_SYNC_ADMIN_USER ?? "admin",
        ONTRAK_ADMIN_PASSWORD: process.env.ONTRAK_SYNC_ADMIN_PASSWORD ?? "change-me-ontrak",
        // The posture this deployment runs: the scans fill the remit and the timer rolls
        // it, which is what makes the *adopted* console — the posture notice, the
        // released rows, the deny list — something a browser test looks at rather than a
        // paragraph in a document. `ONTRAK_SYNC_ADOPT=off` runs the suite against the
        // shipped, claim-by-hand posture instead; the spec decides which assertions
        // apply from the same variable, and the backend is in `off` by default either
        // way, so the shipped default is still the thing no test has to remember.
        ONTRAK_ROLLOUT_ADOPT: process.env.ONTRAK_SYNC_ADOPT ?? "unattended",
      },
    },
    {
      command: `npx next dev -p ${PORT}`,
      cwd: "ontrak-sync/web",
      url: `${baseURL}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        // Empty, so the dashboard serves and proxies its own `/api/*` — see the header.
        NEXT_PUBLIC_ONTRAK_API: "",
        ONTRAK_API_INTERNAL: `http://127.0.0.1:${API_PORT}`,
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
