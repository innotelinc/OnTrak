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
 *
 * And it will not drive a deployment that is not this machine without being told to:
 * the spec writes as it goes, so an address that came from somewhere other than the
 * runner's own harness is refused by name. See `tests/support/live-target.ts`.
 */

import { test, expect, type Page } from "@playwright/test";

import { liveRefusal } from "../support/live-target";

const BASE_URL = process.env.ONTRAK_SYNC_BASE_URL;
/** Why this sweep must not drive the dashboard, or null when it may — see `tests/support/live-target.ts`. */
const BASE_REFUSAL = liveRefusal("ONTRAK_SYNC_BASE_URL", BASE_URL);
const USERNAME = process.env.ONTRAK_SYNC_ADMIN_USER ?? "admin";
const PASSWORD = process.env.ONTRAK_SYNC_ADMIN_PASSWORD ?? "change-me-ontrak";
/** The container the fake Network runs, and the ref the scan flagged as behind. */
const REF = process.env.ONTRAK_SYNC_REF ?? "ghcr.io/innotelinc/monarch/api:1.4";
const CONTAINER = process.env.ONTRAK_SYNC_CONTAINER ?? "monarch";
const HOST = process.env.ONTRAK_SYNC_HOST ?? "i1";
/**
 * Who fills the remit, as the harness was started (`ONTRAK_ROLLOUT_ADOPT`).
 *
 * `off` is the shipped posture and `unattended` is the one this repository deploys, and
 * two assertions differ between them: what an empty remit *says*, and whether a released
 * container is kept out. Everything else — the claim, the roll, the undo, the hold — is
 * the same code either way, which is the point of testing both.
 */
const ADOPT = process.env.ONTRAK_SYNC_ADOPT ?? "off";
const ADOPTING = ADOPT !== "off";
/** The family's own name, which the masthead prints under the product's. */
const DOMAIN = process.env.ONTRAK_PORTAL_BASE_DOMAIN ?? "ontrak.innotel.us";

/** The credentials/CSRF the API insists on for a cookie-authenticated write. */
const CSRF = { "X-Ontrak-CSRF": "1" };

/** Sync is not under Playwright's `baseURL`, so every address is absolute. */
function url(path: string): string {
  return `${BASE_URL}${path}`;
}

test.skip(!BASE_URL, "set ONTRAK_SYNC_BASE_URL (or run `npm run test:e2e:sync`) to drive the dashboard");
// And it refuses an address that is not this machine unless the run says so: this spec
// claims a remit, rolls it and gives it back, which is a write to whatever it is pointed at.
// `playwright.sync.config.ts` starts its own harness on loopback; a deployment is opt-in.
test.skip(Boolean(BASE_REFUSAL), BASE_REFUSAL ?? "");

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
  const username = page.locator('input[name="username"]');
  const password = page.locator('input[name="password"]');
  // The fields are React-controlled, and typing into one before React has taken the
  // page over is a race the first test of the file loses: `next dev` compiles this
  // route on the request that just arrived, hydration lands between the two fills, and
  // the render that follows writes its own (empty) state back over the username — so
  // the button stays disabled and the test waits out its whole timeout at the click.
  // The panel focuses the username field from an effect, which is the first moment
  // React owns the form, so that is what this waits for.
  await expect(username).toBeFocused();
  await username.fill(USERNAME);
  await password.fill(PASSWORD);
  // And the click is only reached once the form agrees the credentials are there: if
  // that race ever comes back, this fails in twenty seconds naming the button rather
  // than ninety naming nothing.
  const submit = page.getByRole("button", { name: "Sign in locally" });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(
    page.getByRole("heading", { name: "Rollouts", level: 1 }),
    "signing in should land on /rollouts",
  ).toBeVisible();
}

test.describe("the rollouts console", () => {
  test("the console wears the family's masthead", async ({ page }) => {
    await signIn(page);

    // The same bar the portal draws on every page: the product's mark, its name and the
    // family's own address on the left, and who the console thinks you are on the right.
    // It used to be a small block at the top of the rail, which made Sync read as a tool
    // with its own chrome rather than as one of the products — and left the address
    // nobody can look up while they are handing out a link.
    const masthead = page.locator("header.masthead");
    await expect(masthead).toBeVisible();
    await expect(masthead).toContainText("OnTrak Sync");
    await expect(masthead).toContainText(DOMAIN);
    await expect(masthead.getByRole("group", { name: "Colour theme" })).toBeVisible();

    // The rail is navigation, not a second header: the product's name lives in the
    // masthead now, and the rail starts with the work.
    await expect(page.locator("nav.nav .brand")).toHaveCount(0);
  });

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

    // Nothing is owned yet, and that has to read as a deliberate statement rather than as
    // a table that failed to load. *Why* it is empty depends on the posture, and the page
    // is expected to say which: on a deployment that claims what the scans find, an empty
    // remit means no pass has run, not that nobody has claimed anything.
    await expect(
      section(page, "The remit").getByText(
        ADOPTING ? "this deployment fills it itself" : "Nothing has been given to this deployment",
      ),
    ).toBeVisible();

    // The posture is stated, with the variable that changes it — the same courtesy the
    // kill switch gets. A page that silently adopts is a page whose operator cannot tell
    // a covered Network from a Network somebody has been adding to by hand.
    const rails = section(page, "The rails in force");
    await expect(rails.getByText(ADOPTING ? "the scans fill it" : "a person claims every row"))
      .toBeVisible();
    if (ADOPTING) {
      await expect(page.getByText("fills its own remit")).toBeVisible();
      await expect(page.getByText("ONTRAK_ROLLOUT_ADOPT=off")).toBeVisible();
    }

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
      headers: CSRF,
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
    await expect(page.getByText(new RegExp(`Released ${escapeRe(REF)} — it is scanned`)))
      .toBeVisible();
    await expect(
      section(page, "The remit").getByText(
        ADOPTING ? "this deployment fills it itself" : "Nothing has been given to this deployment",
      ),
    ).toBeVisible();
    // Back to the posture it started in: the image is still seen, and this deployment no
    // longer owns it. `kept out` rather than `not owned`, on either posture, because a
    // release is a *decision* and the deny list is what records it — on a deployment that
    // adopts what the scans find that decision is the difference between a control and a
    // gesture, and on one that does not it still says why this container is not covered.
    await expect(
      section(page, "What the Network runs").getByRole("row").filter({ hasText: REF })
        .getByText("kept out"),
    ).toBeVisible();
  });
});

/**
 * The posture where the scans fill the remit (`ONTRAK_ROLLOUT_ADOPT`).
 *
 * The interesting half of adoption is not what it takes on — it is what it must *not*
 * take back. A release on an adopting deployment has to be permanent until a person says
 * otherwise, or every pass would undo the operator's last decision and the control would
 * be decorative. So this drives the whole loop: release, watch a pass refuse to readopt,
 * and claim it back — the last of which is a person overriding the deny list, which is
 * what makes it a decision rather than a bug.
 */
test.describe("a deployment that fills its own remit", () => {
  test.skip(!ADOPTING, "run with ONTRAK_SYNC_ADOPT=unattended — `npm run test:e2e:sync` does");

  test("a release keeps a container out, and a claim is the way back", async ({ page }) => {
    await signIn(page);

    // Own it first, so the release below is a release rather than a 404 — and so a retry
    // of this test starts from the same place the first attempt did.
    await page.request.post(url("/api/rollouts/claim"), {
      headers: CSRF,
      data: { host: HOST, container: CONTAINER, ref: REF, service: "api", auto: true },
    });
    await page.reload();

    await section(page, "The remit").getByRole("row").filter({ hasText: REF })
      .getByRole("button", { name: "Release", exact: true }).click();
    await expect(page.getByText(/kept out of the remit/)).toBeVisible();

    // The decision is legible afterwards: who, when and why, rather than a row that
    // simply vanished from a table.
    const keptOut = section(page, "Kept out of the remit");
    const outRow = keptOut.getByRole("row").filter({ hasText: REF });
    await expect(outRow).toBeVisible();
    await expect(outRow.getByText(USERNAME)).toBeVisible();
    await expect(outRow.getByText("released by hand")).toBeVisible();

    // And the image below says the same thing about the same container, so the two
    // panels cannot disagree about whether it is covered.
    await expect(section(page, "What the Network runs").getByRole("row")
      .filter({ hasText: REF }).getByText("kept out")).toBeVisible();

    // A pass over a Network that has been handed back must not take it back. This is the
    // assertion that makes a release a control rather than a gesture, and the run says so
    // in its own sentence instead of reporting an empty remit.
    await page.getByRole("button", { name: "Run a pass now" }).click();
    await expect(page.getByText(/1 kept out of the remit by hand/)).toBeVisible();
    await expect(section(page, "The remit").getByText("this deployment fills it itself"))
      .toBeVisible();
    await expect(keptOut.getByRole("row").filter({ hasText: REF })).toBeVisible();

    // Claiming it again is the door back in, and it is a person's decision: the row leaves
    // the deny list and joins the remit.
    await outRow.getByRole("button", { name: "Claim back…" }).click();
    await page.getByRole("button", { name: "Claim", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Kept out of the remit" })).toHaveCount(0);
    await expect(section(page, "The remit").getByRole("row").filter({ hasText: REF }))
      .toBeVisible();
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
