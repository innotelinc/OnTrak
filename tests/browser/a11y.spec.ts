/**
 * Browser accessibility sweep (paint-dependent rules).
 *
 * `tests/a11y.test.ts` runs axe under jsdom and deliberately disables
 * `color-contrast`, which needs real layout and paint. This spec closes that gap:
 * it runs axe-core against the app in a real Chromium, so contrast and the other
 * computed-style rules are checked, not assumed.
 *
 *   npm run test:a11y                 # boots the app on :3210 and audits it
 *   ONTRAK_A11Y_BASE_URL=... npm run test:a11y   # audit an already-running app
 *
 * The sweep is strict: every WCAG A/AA violation fails, `color-contrast`
 * included. It covers the public pages and the signed-in student, instructor and
 * admin surfaces. A role whose demo account is missing skips rather than flakes.
 */

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { AxeResults } from "axe-core";

const PASSWORD = process.env.ONTRAK_A11Y_PASSWORD ?? "ontrak-demo";
const ACCOUNTS = {
  student: process.env.ONTRAK_A11Y_EMAIL ?? "student@ontrak.local",
  instructor: process.env.ONTRAK_A11Y_INSTRUCTOR_EMAIL ?? "instructor@ontrak.local",
  admin: process.env.ONTRAK_A11Y_ADMIN_EMAIL ?? "admin@ontrak.local",
};

const PUBLIC_PATHS = ["/", "/login", "/register", "/verify"];

/** Run the WCAG A/AA rule set — including the paint-dependent rules. */
async function audit(page: Page) {
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
}

/** A readable one-line-per-violation report for the assertion message. */
function report(violations: AxeResults["violations"]): string {
  return violations.map((violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`).join("\n");
}

/** Fail on every violation: the sweep is the strict gate for the paint rules. */
function expectAccessible(results: AxeResults, label: string): void {
  expect(results.violations, `violations on ${label}:\n${report(results.violations)}`).toEqual([]);
}

/** Audit one page and assert it is clean. */
async function auditPath(page: Page, path: string): Promise<void> {
  // `load`, not `networkidle`: live surfaces (attempt timers) keep connections open.
  const response = await page.goto(path, { waitUntil: "load" });
  expect(response?.status() ?? 500, `${path} should not error`).toBeLessThan(400);
  await page.waitForLoadState("load");
  expectAccessible(await audit(page), path);
}

/** Sign in as one of the seeded demo accounts. Returns false if rejected. */
async function signIn(page: Page, email: string): Promise<boolean> {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 }).catch(() => undefined);
  return !page.url().includes("/login");
}

for (const path of PUBLIC_PATHS) {
  test(`a11y (browser): ${path} passes WCAG A/AA, contrast included`, async ({ page }) => {
    await auditPath(page, path);
  });
}

/** A suite for one role: sign in, then audit each of its surfaces. */
function roleSuite(role: keyof typeof ACCOUNTS, paths: string[]): void {
  test.describe(`${role} surfaces`, () => {
    test.beforeEach(async ({ page }) => {
      test.skip(!(await signIn(page, ACCOUNTS[role])), `no seeded ${role} account`);
    });

    for (const path of paths) {
      test(`a11y (browser): ${path} passes WCAG A/AA`, async ({ page }) => {
        await auditPath(page, path);
      });
    }
  });
}

roleSuite("student", ["/student", "/student/results", "/dashboard"]);

// The attempt workspace is reached through the catalogue; start one if needed.
test.describe("student attempt workspace", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await signIn(page, ACCOUNTS.student)), "no seeded student account");
  });

  test("a11y (browser): the attempt workspace passes WCAG A/AA", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/student", { waitUntil: "load" });

    const onAttempt = () => /\/student\/attempt\//.test(page.url());

    // A resume link first; a stale (expired) attempt is swept server-side, so if
    // it bounces back to /student, fall through to starting a fresh scenario.
    const running = page.locator('a[href*="/student/attempt/"]').first();
    if ((await running.count()) > 0) {
      await running.click();
      await page.waitForURL(/\/student\/attempt\//, { timeout: 20_000 }).catch(() => undefined);
    }

    if (!onAttempt()) {
      await page.goto("/student", { waitUntil: "load" });
      const start = page.getByRole("button", { name: /start scenario/i });
      const count = await start.count();
      if (count === 0) test.skip(true, "no resumable or startable scenario");
      // The demo account may have exhausted its attempt cap on the assigned
      // scenario, so try each start button in turn until one opens an attempt
      // rather than giving up on the first (which the cap may reject).
      for (let index = 0; index < count && !onAttempt(); index += 1) {
        await start.nth(index).click();
        await page.waitForURL(/\/student\/attempt\//, { timeout: 30_000 }).catch(() => undefined);
        if (!onAttempt()) await page.goto("/student", { waitUntil: "load" });
      }
    }

    if (!onAttempt()) test.skip(true, `could not open an attempt (at ${page.url()})`);

    await page.waitForLoadState("load");
    expectAccessible(await audit(page), "the attempt workspace");
  });
});

// The attempt report is where a certificate is drawn, so open a real one rather
// than only the index. A deployment with no finished attempts has nothing to
// audit here, so the test skips instead of flaking.
test.describe("student attempt report", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await signIn(page, ACCOUNTS.student)), "no seeded student account");
  });

  test("a11y (browser): an attempt report passes WCAG A/AA, certificate included", async ({ page }) => {
    await page.goto("/student/results", { waitUntil: "load" });

    // Only a pass draws a certificate, and the index prints the code on those
    // rows — so open one of those rather than whatever attempt happens to be
    // first, otherwise the very thing under test would go unaudited.
    const certified = page.locator('a[href*="/student/results/"]', { hasText: /Certificate ONTRAK-/ });
    if ((await certified.count()) === 0) test.skip(true, "no passed attempt to show a certificate");

    await certified.first().click();
    await page.waitForURL(/\/student\/results\/[^/]+$/, { timeout: 20_000 }).catch(() => undefined);
    await page.waitForLoadState("load");
    await expect(page.getByRole("heading", { name: /certificate/i })).toHaveCount(1);
    expectAccessible(await audit(page), "an attempt report with a certificate");

    // The printable sheet is the version a learner hands to an auditor, and it is
    // deliberately on its own route with its own palette, so audit that too.
    await page.getByRole("link", { name: /print certificate/i }).click();
    await page.waitForURL(/\/certificate\/[^/]+$/, { timeout: 20_000 }).catch(() => undefined);
    await page.waitForLoadState("load");
    await expect(page.getByRole("heading", { name: /certificate/i })).toHaveCount(1);
    expectAccessible(await audit(page), "the printable certificate");
  });
});

roleSuite("instructor", ["/instructor", "/instructor/scenarios", "/instructor/cohorts", "/instructor/analytics"]);
roleSuite("admin", ["/admin", "/admin/users", "/admin/software", "/admin/audit"]);
