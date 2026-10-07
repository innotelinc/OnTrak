/**
 * Every asset a page asks for has to be served.
 *
 * The console has no bundler: `public/` is served as written, through an explicit
 * allowlist (`STATIC_FILES` in `server.ts`) that exists so a file dropped into the
 * directory is not exposed by accident. The cost of an allowlist is that adding a
 * stylesheet is two edits, and forgetting the second one fails **silently** — the
 * HTML loads, the link 404s, and the page just looks wrong.
 *
 * That is not hypothetical: adding `chat-surface.css` and linking it from
 * `index.html` was a 404 until this test's probe caught it by hand. So the rule is
 * checked rather than remembered: every local `href`/`src` in every page must come
 * back `200`.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const PUBLIC_DIR = path.resolve(import.meta.dirname, "..", "..", "public");

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "genie-static-"));
process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_DATA_DIR = path.join(workspace, ".agent");
process.env.AGENT_SANDBOX = "host";
process.env.AGENT_APPROVAL = "off";
process.env.AGENT_MODEL = "fake/model";
process.env.AGENT_FALLBACK_MODELS = "";
process.env.OMNIROUTE_URL = "http://127.0.0.1:1/v1";
// A token is configured on purpose: the shell and its assets are public like the
// sign-in gate, and this pins that they stay reachable without one.
process.env.WEB_TOKEN = "static-token";

const { createServer } = await import("../server.js");
const { ensureWorkspace } = await import("../workspace.js");

await ensureWorkspace();
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(workspace, { recursive: true, force: true });
});

/** Local (root-relative) href/src values in a page, deduplicated. */
function localAssets(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/g)) {
    const value = match[1] ?? "";
    // Skip absolute URLs, data:, and pure fragments.
    if (!value.startsWith("/") || value.startsWith("//")) continue;
    // `/api/...` is a route a page links to (the sign-in gate links to
    // `/api/auth/login`), not a file that has to be on the asset allowlist.
    if (value.startsWith("/api/")) continue;
    found.add(value.split("?")[0] ?? value);
  }
  return [...found];
}

test("every asset the pages reference is served", async () => {
  const pages = ["index.html", "login.html"];
  let checked = 0;
  for (const page of pages) {
    const html = await fs.readFile(path.join(PUBLIC_DIR, page), "utf8");
    const assets = localAssets(html);
    assert.ok(assets.length > 0, `${page} should reference at least one asset`);
    for (const asset of assets) {
      const response = await fetch(`${base}${asset}`);
      assert.equal(
        response.status,
        200,
        `${asset} (referenced by ${page}) is not served — add it to STATIC_FILES in src/server.ts`,
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 5, "the probe should have walked the real assets");
});

test("the chat surface stylesheet is served as CSS", async () => {
  // Named on its own so a rename that keeps the page working still fails loudly
  // here, and so the content type is pinned rather than assumed.
  const response = await fetch(`${base}/chat-surface.css`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/css/);
  const body = await response.text();
  assert.match(body, /\.palette\b/, "the palette's styles travel with it");
  assert.match(body, /\.followup\b/, "so do the follow-up chips'");
});

test("the appearance controls only offer what the theme can paint", async () => {
  const html = await fs.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const css = await fs.readFile(path.join(PUBLIC_DIR, "unity-theme.css"), "utf8");

  assert.match(html, /id="appearance"/, "the panel `?settings=appearance` opens has to exist");
  for (const mode of ["system", "light", "dark"]) {
    assert.match(html, new RegExp(`data-theme-mode="${mode}"`), `${mode} must be offerable`);
  }

  // Every scheme a button names has to have a palette. A scheme with no
  // `:root[data-scheme=...]` block falls back to the default one, so the button
  // would look like it did nothing — the silent failure this test exists for.
  /*
   * The narrow layout does not draw the toolbar button for this panel — three
   * rows of toolbar is the budget on a phone, and this is the one control with
   * another door. So the other doors have to exist: the drawer's own switch
   * (same markup, wired by the same script) and a palette action, which is the
   * only one of the two that reaches the *scheme*, not just the mode.
   */
  const style = await fs.readFile(path.join(PUBLIC_DIR, "style.css"), "utf8");
  assert.match(style, /#appearance-open\s*\{\s*display:\s*none/, "the phone does not draw it");
  const console = await fs.readFile(path.join(PUBLIC_DIR, "app.js"), "utf8");
  assert.match(console, /\{ name: "appearance"/, "so the palette has to offer it");

  const offered = [...html.matchAll(/data-theme-scheme="([^"]+)"/g)].map((match) => match[1] ?? "");
  assert.ok(offered.length >= 2, "more than one scheme should be offerable");
  for (const scheme of offered) {
    // `desk` is the base palette, applied by removing the attribute rather than
    // by a selector of its own — so there is nothing to find in the CSS for it.
    if (scheme === "desk") continue;
    assert.match(
      css,
      new RegExp(`:root\\[data-scheme="${scheme}"\\]`),
      `${scheme} is offered but has no palette in unity-theme.css`,
    );
  }
});

test("the console is laid out for the screen it is on", async () => {
  /*
   * `layout:check` proves all of this in a real browser — at 320, 390, 834 and
   * 1440 pixels, with a thumb and with a mouse — and it skips where there is no
   * Chromium, which is every CI runner this repository has. This is the half
   * that can always run: the rules that make the console adapt have to still be
   * in the stylesheet. It catches the deletion; the browser check catches the
   * mistake.
   */
  const html = await fs.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const css = await fs.readFile(path.join(PUBLIC_DIR, "style.css"), "utf8");
  const chat = await fs.readFile(path.join(PUBLIC_DIR, "chat-surface.css"), "utf8");

  assert.match(html, /viewport-fit=cover/, "a notch has to be accounted for");

  // The phone's only way to the chat list, wired to the panel it opens.
  assert.match(
    html,
    /id="sidebar-toggle"[^>]*aria-controls="sidebar"/,
    "the drawer needs a handle that names what it opens",
  );
  assert.match(html, /id="sidebar-scrim"/, "and something to dismiss it with");

  // Four rules, four different questions — see the comment above them.
  for (const query of [
    "@media (max-width: 1080px)",
    "@media (max-width: 720px)",
    "@media (pointer: coarse)",
    "@media (hover: none)",
    "@media (prefers-reduced-motion: reduce)",
  ]) {
    assert.ok(css.includes(query), `style.css lost \`${query}\``);
  }

  // The tallest viewport a phone will ever show, which is not the height it has.
  assert.match(css, /height: 100dvh/, "100vh alone puts the composer under the address bar");
  // A drawer that is merely translated off-screen is still in the tab order.
  assert.match(
    css,
    /\.sidebar\.open \{[^}]*visibility: visible/,
    "the phone's drawer has to be hidden from the keyboard when closed",
  );
  assert.match(
    chat,
    /safe-area-inset-bottom/,
    "the composer has to keep clear of a home indicator",
  );
});

test("every modal panel can hold focus the way it promises", async () => {
  /*
   * `aria-modal="true"` is a promise that the page behind the panel is inert
   * until it closes. The class flip that shows a panel keeps none of that promise
   * on its own, so `app.js` does three things for all of them: focus in, steer Tab
   * at the edges, hand focus back on close. Two of those three need something from
   * the markup, and both are silent when missing — a panel with no `tabindex`
   * simply keeps the focus it had, and a panel the trap never hears about simply
   * lets Tab walk out. `layout:check` drives the behaviour with real key events;
   * this is the half that runs without a browser.
   */
  const html = await fs.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const app = await fs.readFile(path.join(PUBLIC_DIR, "app.js"), "utf8");

  const panels = [...html.matchAll(/<div[^>]*role="dialog"[^>]*>/gs)].map((match) => match[0]);
  assert.ok(panels.length >= 5, `expected the console's five panels, found ${panels.length}`);
  for (const panel of panels) {
    assert.match(panel, /aria-modal="true"/, "a panel has to say it is modal");
    assert.match(panel, /aria-labelledby=/, "focus lands on the panel, so it needs a name");
    assert.match(
      panel,
      /tabindex="-1"/,
      `a modal panel without tabindex="-1" cannot take focus: ${panel.slice(0, 60)}`,
    );
  }

  // The panels are found from the markup, not from a list that can fall behind it.
  assert.match(app, /querySelectorAll\('\[role="dialog"\]\[aria-modal="true"\]'\)/);
  assert.match(app, /function tabStops\(/, "Tab has to know where a panel's edges are");
  assert.match(app, /function enterDialog\(/, "and opening has to move focus in");
  assert.match(app, /function leaveDialog\(/, "and closing has to hand it back");
  assert.match(
    app,
    /noteDialogOpener\(/,
    "the opener is remembered from the click, which is the only way it survives Safari",
  );
  // One rule, not a per-panel copy: the old ad-hoc ``state.lastFocus`` is gone.
  assert.doesNotMatch(app, /state\.lastFocus/, "focus return should not be done twice");
});

test("the follow-up rule is one module, served to the console", async () => {
  // The console and the CLI must offer the same next steps, so the browser runs
  // the CLI's compiled module rather than a second copy of the rule. `public/`
  // has no bundler, so this endpoint *is* the sharing mechanism — and pinning it
  // is what stops the copy quietly growing back.
  const response = await fetch(`${base}/followups.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /javascript/);
  const body = await response.text();
  assert.match(body, /export function suggestFollowups/, "the CLI's rule is what the browser runs");

  const app = await fs.readFile(path.join(PUBLIC_DIR, "app.js"), "utf8");
  assert.match(app, /from "\/followups\.js"/, "app.js imports the shared rule");
  assert.doesNotMatch(app, /function followupsFor/, "and does not also keep its own");
});

test("an asset that is not on the allowlist is not served", async () => {
  // The allowlist is the point: `public/` is not a directory listing.
  const response = await fetch(`${base}/objectstore-notes.txt`);
  assert.equal(response.status, 404);
});
