/**
 * OnTrak Sync browser spec — the rollouts console, driven end to end.
 *
 * The rest of Sync's suite is `unittest` over the backend and `tsc` over the dashboard,
 * and between them they prove the rails refuse the right things and that the API surface
 * the page calls still type-checks. Neither of them renders anything, so the questions an
 * operator's page actually has to answer had no check at all:
 *
 *   - does an empty remit *say* it is empty, rather than looking like a Network with
 *     nothing left to do?
 *   - does "What the Network runs" show the images the scans found, and say which of them
 *     this deployment owns — the missing-row half of the same statement?
 *   - does `Claim…` fill the form, does the claim land, and does the row then show the
 *     mode, the cooldown and who gave it up?
 *   - does a pass report what it rolled, does the row read `oldimage → newimage`, is Undo
 *     offered on the roll that landed, and does the container come back *held*?
 *   - does clearing the hold and releasing the remit leave the page where it started?
 *
 * That whole walk is here, and it runs against a *real* API. The Network behind it is
 * faked (`ontrak-sync/backend/tests/serve_fake.py`), which is the only part that cannot
 * be real on a runner: the browser, the HTTP layer, the session cookie, the capabilities,
 * the remit store, the rails and the roll itself are all the shipped code, because the
 * credentials in this spec are session credentials and not a monkeypatch.
 *
 * It is opt-in, like the Tix sweep: Sync is only running when somebody started it, so
 * with no `ONTRAK_SYNC_BASE_URL` the whole file skips rather than failing a checkout that
 * never launched the stack. `npm run test:e2e:sync` supplies the address and boots both
 * halves — see `playwright.sync.config.ts`.
 */

import { test, expect, type Page } from "@playwright/test";

const BASE_URL = process.env.ONTRAK_SYNC_BASE_URL;
const USERNAME = process.env.ONTRAK_SYNC_ADMIN_USER ?? "admin";
const PASSWORD = process.env.ONTRAK_SYNC_ADMIN_PASSWORD ?? "change-me-ontrak";
/** The container the fake Network runs, and the ref the scan flagged as behind. */
const REF = process.env.ONTRAK_SYNC_REF ?? "ghcr.io/innotelinc/monarch/api:1.4";
const CONTAINER = process.env.ONTRAK_SYNC_CONTAINER ?? "monarch";
const HOST = process.env.ONTRAK_SYNC_HOST ?? "i1";

/** Sync is not under Playwright's `baseURL`, so every address is absolute. */
function url(path: string): string {
  return `${BASE_URL}${path}`;
}

test.skip(!BASE_URL, "set ONTRAK_SYNC_BASE_URL (or run `npm run test:e2e:sync`) to drive the dashboard");

/** The section whose heading is this text — the page's own unit of interest. */
function section(page: Page, name: string) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) });
}

/**
 * Sign in through the break-glass door, which is the only local door there is.
 *
 * `/login` is single sign-on: with no provider configured it draws no form at all, by
 * design. The local account the harness bootstraps is reached at `/login/break-glass`,
 * and the `next` parameter is the page the API redirects back to.
 */
async function signIn(page: Page): Promise<void> {
  await page.goto(url("/login/break-glass?next=/rollouts"));
  // By `name` rather than by label: the password field's own label wraps the
  // "show the password" checkbox, so its accessible name is "Password show the
  // password" — a label lookup matches two controls and says so.
  await page.locator('input[name="username"]').fill(USERNAME);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in locally" }).click();
  await expect(
    page.getByRole("heading", { name: "Rollouts", level: 1 }),
    "signing in should land on /rollouts",
  ).toBeVisible();
}

test.describe("the rollouts console", () => {
  test("an empty remit says so, and the Network's images say who owns them", async ({ page }) => {
    const faults: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // A 401 is the shell's own question, not a fault: it asks `/api/auth/me` to find
      // out whether anybody is signed in, and "nobody" is a 401 by design — that is the
      // branch that draws the login page rather than showing a page nobody may see. The
      // browser logs the response either way, so it is filtered here and everything else
      // is still a failure.
      if (/401 \(Unauthorized\)/.test(message.text())) return;
      faults.push(message.text());
    });
    await signIn(page);

    // The kill switch is on in the harness, so the banner about it must NOT be drawn: a
    // page that always shows the warning is a page whose warnings nobody reads.
    await expect(page.getByText("ONTRAK_ROLLOUT=1")).toHaveCount(0);

    // Nothing is owned yet. That is the shipped posture, and it has to read as a
    // deliberate statement rather than as a table that failed to load.
    await expect(
      section(page, "The remit").getByText("Nothing has been given to this deployment"),
    ).toBeVisible();

    // The scan's image is visible, and it is visible as *not* owned — the pair of facts
    // that make an empty remit legible.
    const discovered = section(page, "What the Network runs").getByRole("row").filter({ hasText: REF });
    await expect(discovered).toBeVisible();
    await expect(discovered.getByText("not owned")).toBeVisible();
    // Exact, because the image ref contains the container's name: a substring match
    // resolves to two cells (the known target name, and the ref that mentions it).
    await expect(discovered.getByText(CONTAINER, { exact: true })).toBeVisible();

    // The rails are stated, so an operator does not have to go looking for the numbers.
    await expect(section(page, "The rails in force").getByText("cooldown")).toBeVisible();

    expect(faults, `console errors:\n${faults.join("\n")}`).toEqual([]);
  });

  test("claim, roll, undo, clear the hold, release", async ({ page }) => {
    await signIn(page);

    // Start from the posture this test asserts on the way out. A retry after a partial
    // failure would otherwise inherit the remit the first attempt left behind, and the
    // "nothing is owned" assertion below would fail for a reason the code did not
    // cause. `page.request` shares this browser context, so it carries the session
    // cookie the sign-in just set; a release that matches nothing is a 404 and is
    // exactly the case being cleared away.
    await page.request.post(url("/api/rollouts/release"), {
      headers: { "X-Ontrak-CSRF": "1" },
      data: { host: HOST, container: CONTAINER, ref: REF },
    });

    // ── claim ────────────────────────────────────────────────────────────────
    // Through the button on the image row, which is how an operator reaches it: the
    // form fills itself from what the scan saw so the triple cannot be mistyped.
    await section(page, "What the Network runs")
      .getByRole("row")
      .filter({ hasText: REF })
      .getByRole("button", { name: "Claim…" })
      .click();
    // The compose service is not in a finding, so the form leaves it for the person —
    // and the roll resolves the invocation from the container's labels anyway.
    await page.getByLabel("service").fill("api");
    await page.getByRole("button", { name: "Claim", exact: true }).click();
    await expect(page.getByText(`Claimed ${REF} on ${HOST}.`)).toBeVisible();

    // The remit now has the row, in the unattended mode the form defaults to, and it is
    // eligible now because nothing has ever rolled it.
    const remitRow = section(page, "The remit").getByRole("row").filter({ hasText: REF });
    await expect(remitRow).toBeVisible();
    await expect(remitRow.getByText("unattended")).toBeVisible();
    await expect(remitRow.getByText("now")).toBeVisible();
    await expect(remitRow.getByText(USERNAME)).toBeVisible();
    await expect(
      section(page, "What the Network runs").getByRole("row").filter({ hasText: REF })
        .getByText("in the remit"),
    ).toBeVisible();

    // ── roll ─────────────────────────────────────────────────────────────────
    await page.getByRole("button", { name: "Run a pass now" }).click();
    // The summary is a text node immediately followed by the pass's messages inside one
    // element, so their text contents are adjacent with nothing between them — which is
    // why this is `1 rolled` and not `\b1 rolled\b`. The boundary would have to fall
    // between the summary and the daemon's sentence, and there is no character there.
    await expect(page.getByText(/1 rolled/)).toBeVisible();

    const rollRow = section(page, "Rolls").getByRole("row").filter({ hasText: REF });
    await expect(rollRow).toBeVisible();
    await expect(rollRow.getByText("rolled", { exact: true })).toBeVisible();
    // The daemon's own ids, shortened the way the table draws them: the image it was
    // running, then the one it was asked to become.
    await expect(rollRow.getByText("oldimage → newimage")).toBeVisible();
    await expect(rollRow.getByText(/rolled to/)).toBeVisible();

    // ── undo ─────────────────────────────────────────────────────────────────
    // Offered on the roll that landed, and only there. The undo puts the previous image
    // back and *holds* the container, which is the half an operator has to be told.
    await rollRow.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText(new RegExp(`Undo of roll #\\d+: .*${escapeRe(REF)} is held`)))
      .toBeVisible();

    const heldRow = section(page, "The remit").getByRole("row").filter({ hasText: REF });
    await expect(heldRow.getByText("blocked")).toBeVisible();
    // A second undo is not offered: the newest attempt on this container is the undo
    // itself, and repeating it would be a no-op — see `undoable` on the page.
    await expect(section(page, "Rolls").getByRole("button", { name: "Undo" })).toHaveCount(0);

    // ── clear the hold ───────────────────────────────────────────────────────
    await heldRow.getByRole("button", { name: "Clear hold" }).click();
    await expect(page.getByText(`Cleared the hold on ${REF} — the next pass may roll it.`))
      .toBeVisible();
    await expect(
      section(page, "The remit").getByRole("row").filter({ hasText: REF }).getByText("blocked"),
    ).toHaveCount(0);

    // ── release ──────────────────────────────────────────────────────────────
    await page.getByRole("button", { name: "Release", exact: true }).click();
    await expect(
      page.getByText(`Released ${REF} — it is scanned and left alone from now on.`),
    ).toBeVisible();
    await expect(
      section(page, "The remit").getByText("Nothing has been given to this deployment"),
    ).toBeVisible();
    // Back to the posture it started in: the image is still seen, and still not owned.
    await expect(
      section(page, "What the Network runs").getByRole("row").filter({ hasText: REF })
        .getByText("not owned"),
    ).toBeVisible();
  });
});

/**
 * The dev server's hot-reload socket, which is the one thing in this file that only a
 * *dev* server has.
 *
 * Next 16 answers the HMR handshake `Unauthorized` when the request's `Origin` is not in
 * `allowedDevOrigins`, and a WebSocket handshake always carries one — so a dashboard
 * without that list in its `next.config.ts` fills the console with
 * `WebSocket connection to '…/_next/hmr' failed` and a reconnect every second while every
 * page still works. That is invisible to a typecheck and to every backend test, and it is
 * exactly the kind of failure a browser spec exists to catch: the page is fine, the
 * console is not, and the dev loop is quietly broken. `ONTRAK_SYNC_DEV=1` says the
 * address under test is a dev server; `npm run test:e2e:sync` sets it.
 */
test("the dev server's hot-reload socket connects", async ({ page }) => {
  test.skip(process.env.ONTRAK_SYNC_DEV !== "1", "only meaningful against a dev server");

  const sockets: string[] = [];
  const errors: string[] = [];
  page.on("websocket", (socket) => {
    if (socket.url().includes("/_next/hmr")) sockets.push(socket.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(url("/login/break-glass"));
  await expect
    .poll(() => sockets.length, { message: "the HMR socket was never opened" })
    .toBeGreaterThan(0);
  // The failure is asynchronous — the handshake is refused after the socket is created —
  // so give the reconnect a beat to show up before reading the console.
  await page.waitForTimeout(2_000);

  const refused = errors.filter((text) => /WebSocket|hmr/i.test(text));
  expect(refused, `the dev server refused its own HMR socket:\n${refused.join("\n")}`).toEqual([]);
});

/** A ref in a regex, so `:` and `.` are literals rather than wildcards. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
