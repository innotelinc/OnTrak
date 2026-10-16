#!/usr/bin/env node
/**
 * Does the console adapt to the screen it is on?
 *
 *   npm run layout:check
 *
 * There is no build step and no DOM test runner in this repository, and the
 * stylesheet is where that costs the most. Every other rule in here is checked
 * against something that *fails* when it is broken: a route 404s, a type does not
 * compile, a test goes red. Responsive CSS has no such signal — the page still
 * loads, every test still passes, and the only symptom is a control a person on a
 * phone cannot reach. That is the silent failure this script exists for.
 *
 * It serves the real shell (the real `public/`, the real `server.ts` allowlist)
 * and drives a real Chromium, at three viewports, and asserts the things that are
 * *true on every device* rather than the numbers that happen to be in the CSS:
 *
 *   - nothing overflows sideways, and no control is pushed off the edge
 *   - the page is exactly as tall as the viewport it is given (`dvh`, not `vh`)
 *   - a phone gets a drawer it can open and close, and a desktop gets a column
 *   - every control clears the WCAG 2.5.8 floor of 24px, and the toolbar clears
 *     44px for a finger
 *   - a focused field is at least 16px, so iOS Safari does not zoom the console
 *   - `prefers-reduced-motion` actually stops the animations
 *
 * Like `ui:smoke`, it needs a browser on the machine and skips without one. It
 * needs `dist/` (so run it after `npm run build`, or as part of `npm run check`).
 *
 *   CHROME_PATH   only if the browser is somewhere unusual
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* A browser, if there is one. The same two places `ui-smoke` looks. */
function findChrome() {
  const explicit = process.env.CHROME_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const candidates = [];
  const playwright = path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    for (const entry of fs.readdirSync(playwright)) {
      if (!entry.startsWith("chromium-")) continue;
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-linux64/headless_shell"]) {
        candidates.push(path.join(playwright, entry, rel));
      }
    }
  } catch {
    /* Playwright is not installed here */
  }
  candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome");

  return candidates.sort().reverse().find((candidate) => fs.existsSync(candidate)) ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* --------------------------------------------------------------- the shell -- */

/*
 * The real server, on a scratch workspace: the point is to check the CSS the
 * browser is actually served, not a copy of the page this script keeps in step
 * by hand. No `WEB_TOKEN`, so the console is reachable without a cookie and the
 * page boots the way a signed-in visitor sees it.
 */
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "genie-layout-"));
process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_DATA_DIR = path.join(workspace, ".agent");
process.env.AGENT_SANDBOX = "host";
process.env.AGENT_APPROVAL = "off";
process.env.AGENT_MODEL = "fake/model";
process.env.AGENT_FALLBACK_MODELS = "";
process.env.OMNIROUTE_URL = "http://127.0.0.1:1/v1";
process.env.PREVIEW_ENABLED = "false";
delete process.env.WEB_TOKEN;

/* ------------------------------------------------------------- the browser -- */

async function connect(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          socket.addEventListener("open", resolve, { once: true });
          socket.addEventListener("error", () => reject(new Error("could not attach to the page")), {
            once: true,
          });
        });
        return socket;
      }
    } catch {
      /* the browser is still starting */
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the browser's debug endpoint");
    await sleep(300);
  }
}

let nextId = 1;
const pending = new Map();
let socket = null;
const pageErrors = [];

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

/** Run an expression in the page and bring the value back. */
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression: `(() => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitFor(expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(`return Boolean(${expression});`)) return true;
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
}

/* A key, sent the way a browser's own Tab traversal is driven: `rawKeyDown` for
   a key that produces no text, then `keyUp` to close it out. */
async function press(name, { shift = false } = {}) {
  const keys = {
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  };
  const modifiers = shift ? 8 : 0; // Alt 1, Ctrl 2, Meta 4, Shift 8.
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers, ...keys[name] });
  await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...keys[name] });
  await sleep(40);
}

/**
 * A real click at a control's centre, not `element.click()`.
 *
 * The difference is the whole point of the check it drives: a real click is what
 * focuses the button, and a panel that hands focus back has to know where from.
 */
async function clickControl(selector) {
  const centre = await evaluate(`
    const el = document.querySelector('${selector}');
    if (el === null) throw new Error('no ${selector}');
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  `);
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: centre.x, y: centre.y, button: "left", buttons: 1, clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: centre.x, y: centre.y, button: "left", buttons: 0, clickCount: 1,
  });
  await sleep(60);
}

/** Where focus is, and whether it is inside a given panel. */
async function focusedIn(panelSelector) {
  return evaluate(`
    const panel = document.querySelector('${panelSelector}');
    const el = document.activeElement;
    return {
      where: el === null ? "none" : (el.id || String(el.className) || el.tagName.toLowerCase()).slice(0, 40),
      inside: el !== null && panel.contains(el),
      onPanel: el === panel,
    };
  `);
}

/**
 * Tab a given number of times from wherever focus is, and report whether it ever
 * left the panel — and how many distinct controls it reached.
 *
 * The count is not decoration: "focus never left" is true of a walk that never
 * moved either, so a check that only looked for escape would pass on a page whose
 * Tab does nothing at all.
 */
async function tabWalk(panelSelector, presses, { shift = false } = {}) {
  const seen = new Set();
  let escaped = null;
  for (let i = 0; i < presses; i += 1) {
    await press("Tab", { shift });
    const at = await focusedIn(panelSelector);
    if (!at.inside && escaped === null) escaped = `press ${i + 1} landed on ${at.where}`;
    else if (at.inside) seen.add(at.where);
  }
  return { stops: seen.size, escaped };
}

/* ---------------------------------------------------------------- checks ---- */

let failures = 0;

async function check(label, fn) {
  try {
    const outcome = await fn();
    if (outcome === false) {
      failures += 1;
      console.log(`  ✗ ${label}`);
    } else {
      console.log(`  ✓ ${label}${typeof outcome === "string" ? ` — ${outcome}` : ""}`);
    }
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${label}\n      ${error.message}`);
  }
}

/**
 * The page, measured once.
 *
 * One round trip per viewport rather than one per assertion: a report object can
 * be printed as a whole when something is wrong, where twenty small probes would
 * only say which one disagreed.
 *
 * `visible` is deliberately strict — `visibility: hidden` is how the phone's
 * drawer is taken out of the tab order, so a control that is merely translated
 * off-screen would not be caught by a rect check alone.
 */
const PROBE = `
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const name = (el) => (el.id ? "#" + el.id : el.className || el.tagName.toLowerCase()).toString().slice(0, 32);
  const interactive = () =>
    [...document.querySelectorAll("button, select, textarea, input, a[href], summary")].filter(
      (el) => visible(el) && !el.classList.contains("skip-link"),
    );

  const app = document.querySelector(".app");
  const sidebar = document.querySelector("#sidebar");
  const toggle = document.querySelector("#sidebar-toggle");

  /* Every control in the two bars a person uses to drive the console. */
  const offscreen = [...document.querySelectorAll(".topbar button, .topbar select, .composer button, .composer textarea")]
    .filter(visible)
    .map((el) => ({ control: name(el), ...box(el) }))
    .filter((r) => r.x < -1 || r.x + r.w > innerWidth + 1);

  return {
    viewport: { w: innerWidth, h: innerHeight },
    horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    app: { ...box(app), columns: getComputedStyle(app).gridTemplateColumns, overflowY: getComputedStyle(app).overflowY },
    sidebar: {
      ...box(sidebar),
      position: getComputedStyle(sidebar).position,
      visibility: getComputedStyle(sidebar).visibility,
    },
    toggle: { ...box(toggle), visible: visible(toggle), expanded: toggle.getAttribute("aria-expanded") },
    scrim: {
      visible: visible(document.querySelector("#sidebar-scrim")),
      zIndex: getComputedStyle(document.querySelector("#sidebar-scrim")).zIndex,
    },
    offscreen,
    /* The 44px promise: the toolbar and the composer are what a phone's thumb
       has to hit. Everything else only has to clear 24px (WCAG 2.5.8). */
    below44: [
      ...document.querySelectorAll(".topbar button, .topbar select, .composer button, #sidebar-toggle, #new-chat"),
    ]
      .filter(visible)
      .map((el) => ({ control: name(el), ...box(el) }))
      .filter((r) => r.h < 44),
    below24: interactive()
      .map((el) => ({ control: name(el), ...box(el) }))
      .filter((r) => r.h < 24),
    inputFontSize: parseFloat(getComputedStyle(document.querySelector("#input")).fontSize),
    sidebarTransition: getComputedStyle(sidebar).transitionDuration,
    media: {
      coarse: matchMedia("(pointer: coarse)").matches,
      noHover: matchMedia("(hover: none)").matches,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    },
  };
`;

/* ----------------------------------------------------------------- main ---- */

const chromePath = findChrome();
if (chromePath === null) {
  console.log("No Chromium found. Install one (Playwright downloads to ~/.cache/ms-playwright)");
  console.log("or point CHROME_PATH at a chrome binary. Skipping the layout check.");
  process.exit(0);
}

const { createServer } = await import("../dist/server.js");
const { ensureWorkspace } = await import("../dist/workspace.js");

await ensureWorkspace();
const server = createServer();
const base = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});

const port = 9500 + Math.floor(Math.random() * 400);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "genie-layout-profile-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  // `detached` gives the browser its own process group, so the whole group can be
  // killed below. See the `finally` block for why that matters.
  { stdio: ["ignore", "ignore", "pipe"], detached: true },
);

/** One viewport: emulate it, load the console, and report what it measures. */
async function at(width, height, { touch = false } = {}) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: touch ? 3 : 1,
    mobile: touch,
  });
  // 0 is rejected by the protocol; a disabled emulation ignores the count.
  await send("Emulation.setTouchEmulationEnabled", {
    enabled: touch,
    maxTouchPoints: touch ? 5 : 1,
  });
  await send("Page.navigate", { url: `${base}/` });
  /*
   * `.composer-hint` is built by `wire()` in `app.js`, so its presence is the
   * proof that the console is *wired* — not merely parsed. Waiting on an element
   * that `index.html` already carries would measure a page whose buttons exist
   * and do nothing, and every interaction check would pass for the wrong reason.
   */
  const booted = await waitFor("document.querySelector('.composer-hint')");
  if (!booted) throw new Error("the console never finished wiring itself");
  // The shell renders before its first paint settles; one frame is enough for the
  // layout to be final, since nothing here is animated on load.
  await evaluate("return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));");
  return evaluate(PROBE);
}

try {
  socket = await connect(port);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      pageErrors.push(details?.exception?.description ?? details?.text ?? "unknown exception");
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
      pageErrors.push((message.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });

  await send("Runtime.enable");
  await send("Page.enable");

  console.log(`Browser   ${chromePath}`);
  console.log(`Shell     ${base}\n`);

  /* ---------------------------------------------------------------- phone -- */

  console.log("iPhone 14 (390x844, portrait, touch)");
  const phone = await at(390, 844, { touch: true });

  await check("the page is no wider than the screen", () => {
    if (phone.horizontalOverflow > 1) throw new Error(`overflows by ${phone.horizontalOverflow}px`);
    return `${phone.viewport.w}px wide, nothing past it`;
  });

  await check("the console is exactly as tall as the viewport", () => {
    const delta = Math.abs(phone.app.h - phone.viewport.h);
    if (delta > 1) {
      throw new Error(`.app is ${phone.app.h}px tall in a ${phone.viewport.h}px viewport`);
    }
    return `${phone.app.h}px — dvh, not vh`;
  });

  await check("no control is pushed off the edge", () => {
    if (phone.offscreen.length > 0) {
      throw new Error(phone.offscreen.map((r) => `${r.control} at x=${r.x}..${r.x + r.w}`).join(", "));
    }
    return "the toolbar wraps rather than overflow";
  });


  await check("the chat list is a drawer, not a column", () => {
    if (phone.sidebar.position !== "fixed") throw new Error(`position is ${phone.sidebar.position}`);
    if (phone.sidebar.visibility !== "hidden") throw new Error("a closed drawer is still in the tab order");
    if (!phone.toggle.visible) throw new Error("nothing opens the drawer");
    return `${phone.sidebar.w}px wide, hidden until asked for`;
  });

  await check("a thumb can hit the controls", () => {
    if (phone.media.coarse && phone.below44.length > 0) {
      throw new Error(phone.below44.map((r) => `${r.control} is ${r.h}px`).join(", "));
    }
    return phone.media.coarse
      ? "every toolbar control is 44px or taller"
      : "touch could not be emulated on this build; not asserted";
  });

  await check("no control is below the 24px floor", () => {
    if (phone.below24.length > 0) {
      throw new Error(phone.below24.map((r) => `${r.control} is ${r.h}px`).join(", "));
    }
    return "WCAG 2.5.8";
  });

  await check("a focused field is 16px, so iOS does not zoom the page", () => {
    if (phone.media.coarse && phone.inputFontSize < 16) {
      throw new Error(`#input computes to ${phone.inputFontSize}px`);
    }
    return `${phone.inputFontSize}px`;
  });

  await check("the drawer opens, traps nothing, and closes", async () => {
    await evaluate("document.querySelector('#sidebar-toggle').click();");
    /*
     * Wait for the slide to *settle*, not for the clock to pass. A fixed sleep is
     * a bet on how loaded the machine is, and losing that bet looks exactly like a
     * broken drawer — which is how this check failed once, in a run that also had
     * the test suite and a browser in flight. `transform: none` is the end of the
     * transition; a matrix mid-flight is not.
     */
    await waitFor(`
      getComputedStyle(document.querySelector('#sidebar')).transform === 'none'
    `, 5_000);
    const opened = await evaluate(`
      const sidebar = document.querySelector('#sidebar');
      const r = sidebar.getBoundingClientRect();
      return {
        visibility: getComputedStyle(sidebar).visibility,
        x: Math.round(r.left),
        expanded: document.querySelector('#sidebar-toggle').getAttribute('aria-expanded'),
        scrim: !document.querySelector('#sidebar-scrim').classList.contains('hidden'),
        overflowsRight: Math.round(r.right) > innerWidth + 1,
      };
    `);
    if (opened.visibility !== "visible") throw new Error("the drawer did not become visible");
    if (opened.x < -1 || opened.overflowsRight) throw new Error("the drawer is off-screen while open");
    if (opened.expanded !== "true") throw new Error("aria-expanded still says the drawer is closed");
    if (!opened.scrim) throw new Error("no scrim behind the drawer");

    // The scrim is the first gesture anyone tries, so it is the one that is
    // checked; Escape is wired in the same handler and covered by its own check.
    await evaluate("document.querySelector('#sidebar-scrim').click();");
    // The other direction is a `visibility` flip, deliberately delayed to the end
    // of the slide, so it is the thing that has to be waited for here.
    await waitFor(`
      getComputedStyle(document.querySelector('#sidebar')).visibility === 'hidden'
    `, 5_000);
    const closed = await evaluate(`
      const sidebar = document.querySelector('#sidebar');
      return {
        visibility: getComputedStyle(sidebar).visibility,
        expanded: document.querySelector('#sidebar-toggle').getAttribute('aria-expanded'),
        scrim: !document.querySelector('#sidebar-scrim').classList.contains('hidden'),
      };
    `);
    if (closed.visibility !== "hidden") throw new Error("tapping the scrim left the drawer open");
    if (closed.expanded !== "false") throw new Error("aria-expanded did not follow it back");
    if (closed.scrim) throw new Error("the scrim stayed up over a closed drawer");
    return "open -> scrim -> closed, with aria-expanded in step";
  });

  await check("Escape closes the drawer", async () => {
    await evaluate("document.querySelector('#sidebar-toggle').click();");
    await waitFor(
      "getComputedStyle(document.querySelector('#sidebar')).transform === 'none'",
      5_000,
    );
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    await sleep(80);
    await sleep(60);
    const expanded = await evaluate(
      "return document.querySelector('#sidebar-toggle').getAttribute('aria-expanded');",
    );
    if (expanded !== "false") throw new Error("Escape did not dismiss it");
    return "the keyboard has the same way out as the thumb";
  });

  await check("the one control the phone does not draw is still reachable", async () => {
    // Three stacked rows of toolbar is the budget on a phone, and `appearance`
    // is the control that pays for it — because it is the only one with a
    // second door. Both halves of that promise are checked, so "not drawn" can
    // never quietly become "not there".
    const toolbar = await evaluate(`
      const button = document.querySelector('#appearance-open');
      return {
        drawn: getComputedStyle(button).display !== 'none',
        drawerSwitch: document.querySelectorAll('.ot-theme [data-theme-mode]').length,
      };
    `);
    if (toolbar.drawn) throw new Error("the appearance button is still drawn on a phone");
    if (toolbar.drawerSwitch < 3) throw new Error("the drawer's own theme switch is missing too");

    // And the deep link the documentation promises still opens the panel.
    await send("Page.navigate", { url: `${base}/?settings=appearance` });
    const booted = await waitFor("document.querySelector('.composer-hint')");
    if (!booted) throw new Error("the console did not boot on the deep link");
    const shown = await evaluate(
      "return !document.querySelector('#appearance').classList.contains('hidden');",
    );
    if (!shown) throw new Error("?settings=appearance no longer opens the panel");
    return "not drawn, but in the drawer and behind ?settings=appearance";
  });

  /* --------------------------------------------------- other shapes of phone -- */

  /*
   * The two ends of "a phone". 320px is the narrowest viewport still in use and
   * is where a toolbar that does not wrap shows itself; 844x390 is the same
   * phone turned on its side, where a layout keyed to width alone gets to be
   * wrong — and where the height, not the width, is the scarce thing.
   */
  for (const [label, width, height] of [
    ["Smallest phone (320x568, portrait, touch)", 320, 568],
    ["Phone in landscape (844x390, touch)", 844, 390],
  ]) {
    console.log(`\n${label}`);
    const report = await at(width, height, { touch: true });

    await check("the page is no wider than the screen", () => {
      if (report.horizontalOverflow > 1) throw new Error(`overflows by ${report.horizontalOverflow}px`);
      return `${report.viewport.w}px wide, nothing past it`;
    });

    await check("the console is exactly as tall as the viewport", () => {
      const delta = Math.abs(report.app.h - report.viewport.h);
      if (delta > 1) throw new Error(`.app is ${report.app.h}px tall in a ${report.viewport.h}px viewport`);
      return `${report.app.h}px`;
    });

    await check("no control is pushed off the edge", () => {
      if (report.offscreen.length > 0) {
        throw new Error(report.offscreen.map((r) => `${r.control} at x=${r.x}..${r.x + r.w}`).join(", "));
      }
      return "the toolbar wraps rather than overflow";
    });

    await check("no control is below the 24px floor", () => {
      if (report.below24.length > 0) {
        throw new Error(report.below24.map((r) => `${r.control} is ${r.h}px`).join(", "));
      }
      return "WCAG 2.5.8";
    });
  }

  /* --------------------------------------------------------------- tablet -- */

  console.log("\niPad Air (834x1112, portrait, touch)");
  const tablet = await at(834, 1112, { touch: true });

  await check("the page is no wider than the screen", () => {
    if (tablet.horizontalOverflow > 1) throw new Error(`overflows by ${tablet.horizontalOverflow}px`);
    return `${tablet.viewport.w}px wide, nothing past it`;
  });

  await check("no control is pushed off the edge", () => {
    if (tablet.offscreen.length > 0) {
      throw new Error(tablet.offscreen.map((r) => `${r.control} at x=${r.x}`).join(", "));
    }
    return "the toolbar wraps rather than overflow";
  });

  await check("the chat list is a column again", () => {
    if (tablet.sidebar.position !== "static") throw new Error(`position is ${tablet.sidebar.position}`);
    if (tablet.sidebar.visibility !== "visible") throw new Error("the column is hidden");
    if (tablet.toggle.visible) throw new Error("the drawer handle is showing on a tablet");
    return `${tablet.sidebar.w}px, in the flow`;
  });

  await check("a finger still gets 44px, wide screen or not", () => {
    // The point of keying target size to the pointer rather than the viewport:
    // a 1024px tablet is exactly where small targets hurt most.
    if (tablet.media.coarse && tablet.below44.length > 0) {
      throw new Error(tablet.below44.map((r) => `${r.control} is ${r.h}px`).join(", "));
    }
    return tablet.media.coarse ? "44px on a touch pointer" : "touch not emulated; not asserted";
  });

  await check("the conversation keeps its room", () => {
    const tracks = tablet.app.columns.trim().split(/\s+/).length;
    if (tracks !== 2) throw new Error(`the grid has ${tracks} tracks: ${tablet.app.columns}`);
    return `${tablet.app.columns} — sidebar, conversation`;
  });

  /* -------------------------------------------------------------- desktop -- */

  console.log("\nDesktop (1440x900, fine pointer, hover)");
  const desktop = await at(1440, 900);

  await check("the console is exactly as tall as the viewport", () => {
    const delta = Math.abs(desktop.app.h - desktop.viewport.h);
    if (delta > 1) throw new Error(`.app is ${desktop.app.h}px tall in a ${desktop.viewport.h}px viewport`);
    return `${desktop.app.h}px`;
  });

  await check("the chat list is a docked column", () => {
    if (desktop.sidebar.position !== "static") throw new Error(`position is ${desktop.sidebar.position}`);
    if (desktop.toggle.visible) throw new Error("the drawer handle is showing on a desktop");
    return `${desktop.sidebar.w}px, always on screen`;
  });

  await check("the preview rail has its own track", () => {
    const tracks = desktop.app.columns.trim().split(/\s+/).length;
    if (tracks !== 3) throw new Error(`the grid has ${tracks} tracks: ${desktop.app.columns}`);
    return `${desktop.app.columns} — sidebar, conversation, preview`;
  });

  await check("a mouse does not have to hit 44px", () => {
    // Not a failure either way — it pins that the growth is conditional, so a
    // 44px toolbar on an 800px-wide desktop window is visible as a change.
    return desktop.media.coarse ? "the pointer reports coarse (assertion skipped)" : "targets stay as drawn";
  });

  /* -------------------------------------------------------- dialog and focus -- */

  console.log("\nDialogs and focus (desktop, keyboard)");

  await check("opening a panel moves focus into it", async () => {
    await clickControl("#chat-settings");
    const at = await focusedIn("#settings");
    if (!at.inside) throw new Error(`focus is on ${at.where}, not in the panel`);
    return at.onPanel
      ? "the panel takes focus, so its title is read before its controls"
      : `focus on ${at.where}`;
  });

  await check("Tab walks the panel and cannot leave it", async () => {
    const walk = await tabWalk("#settings", 10);
    if (walk.escaped !== null) throw new Error(walk.escaped);
    if (walk.stops < 2) {
      throw new Error(`Tab reached only ${walk.stops} control(s), so this proves nothing`);
    }
    return `${walk.stops} controls walked, never outside`;
  });

  await check("Shift+Tab cannot leave it either", async () => {
    const walk = await tabWalk("#settings", 6, { shift: true });
    if (walk.escaped !== null) throw new Error(walk.escaped);
    if (walk.stops < 2) throw new Error("Shift+Tab never moved");
    return `${walk.stops} controls walked backwards`;
  });

  await check("closing a panel hands focus back to what opened it", async () => {
    await press("Escape");
    const at = await focusedIn("#settings");
    if (at.inside) throw new Error("the panel is still open");
    if (at.where !== "chat-settings") throw new Error(`focus went to ${at.where}`);
    return "#chat-settings — the button that was pressed";
  });

  await check("the sweep panel, which has its own two handlers, behaves the same", async () => {
    await clickControl("#sweep-open");
    const opened = await focusedIn("#sweep");
    if (!opened.inside) throw new Error(`focus is on ${opened.where}, not in the panel`);
    const walk = await tabWalk("#sweep", 8);
    if (walk.escaped !== null) throw new Error(walk.escaped);
    await press("Escape");
    const closed = await focusedIn("#sweep");
    if (closed.inside) throw new Error("Escape left the panel open");
    if (closed.where !== "sweep-open") throw new Error(`focus went to ${closed.where}`);
    return `${walk.stops} controls, and back to #sweep-open`;
  });

  /*
   * The two controls an *uploaded* project arrives through, driven the way a
   * person drives them: the file input and the publish dialog live in the
   * workspace panel, and the dialog is a real modal like every other one — so it
   * has to take focus, keep Tab inside itself, forget the GitHub token field when
   * Atlas is chosen, and hand focus back on Escape.
   *
   * What is *not* checked here is the upload itself: a real .zip fixture belongs in
   * `src/test/project-zip.test.ts`, where the assertion is about the files that
   * land rather than about a file chooser either way.
   */
  await check("an uploaded project's controls are where a person expects them", async () => {
    await send("Page.navigate", { url: `${base}/` });
    const booted = await waitFor("document.querySelector('.composer-hint')");
    if (!booted) throw new Error("the console did not boot");

    await clickControl("#toggle-files");
    const accepted = await evaluate(`
      const upload = document.querySelector('#project-upload-file');
      const publish = document.querySelector('#project-publish');
      return {
        upload: upload !== null && (upload.getAttribute('accept') ?? '').includes('.zip'),
        publish: publish !== null,
        log: document.querySelector('#project-import-log') !== null,
      };
    `);
    if (!accepted.upload) throw new Error("the file input does not accept a .zip");
    if (!accepted.publish) throw new Error("there is no publish control");
    if (!accepted.log) throw new Error("there is nowhere for an upload's install log to go");

    await clickControl("#project-publish");
    const opened = await waitFor(`!document.querySelector('#publish').classList.contains('hidden')`, 5_000);
    if (!opened) throw new Error("the publish dialog did not open");
    const inside = await focusedIn("#publish");
    if (!inside.inside) throw new Error(`focus is on ${inside.where}, not in the dialog`);

    const said = await evaluate(`return document.querySelector('#publish-note').textContent.trim();`);
    if (said === "") throw new Error("the dialog does not say where the project would go");

    // The token is GitHub's requirement, so its field follows the choice.
    const toggled = await evaluate(`
      const select = document.querySelector('#publish-target');
      const field = document.querySelector('#publish-token-field');
      const before = field.classList.contains('hidden');
      select.value = 'github';
      select.dispatchEvent(new Event('change'));
      const afterGithub = field.classList.contains('hidden');
      select.value = 'atlas';
      select.dispatchEvent(new Event('change'));
      return { before, afterGithub, afterAtlas: field.classList.contains('hidden') };
    `);
    if (toggled.afterGithub) throw new Error("choosing GitHub did not ask for a token");
    if (!toggled.afterAtlas) throw new Error("choosing Atlas left the GitHub token field on screen");

    const walk = await tabWalk("#publish", 12);
    if (walk.escaped !== null) throw new Error(walk.escaped);
    await press("Escape");
    const closed = await focusedIn("#publish");
    if (closed.inside) throw new Error("Escape left the publish dialog open");
    if (closed.where !== "project-publish") throw new Error(`focus went to ${closed.where}`);
    return `${walk.stops} stops, and back to #project-publish`;
  });

  /*
   * A project row, which is where the two actions of an uploaded project live for
   * every *other* way one can arrive (a clone, a bundle, a folder made by hand):
   * `install` and `export`/`publish`. Built through the API rather than by hand so
   * the row is the one the console really draws, and removed again at the end so
   * the check leaves the workspace as it found it.
   *
   * What is not clicked here is `install` itself: that runs a real installer, and
   * this harness is for the console's shape, not for npm. The button's presence and
   * its enabled state are what a row can get wrong.
   */
  await check("a project row offers the actions an uploaded project needs", async () => {
    const headers = {
      "Content-Type": "application/json",
      ...(process.env.WEB_TOKEN ? { Authorization: `Bearer ${process.env.WEB_TOKEN}` } : {}),
    };
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "layout check project" }),
    });
    if (!created.ok) throw new Error(`could not make a project to look at: HTTP ${created.status}`);
    const { project } = await created.json();

    try {
      await send("Page.navigate", { url: `${base}/` });
      const booted = await waitFor("document.querySelector('.composer-hint')");
      if (!booted) throw new Error("the console did not boot");
      await clickControl("#toggle-files");
      const listed = await waitFor(`
        [...document.querySelectorAll('#projects-list .project')]
          .some((el) => el.textContent.includes('layout check project'))
      `, 5_000);
      if (!listed) throw new Error("the project is saved but the panel lists no row for it");

      const found = await evaluate(`
        const row = [...document.querySelectorAll('#projects-list .project')]
          .find((el) => el.textContent.includes('layout check project'));
        if (row === undefined) return null;
        const buttons = [...row.querySelectorAll('button')].map((b) => ({
          label: b.textContent.trim(),
          disabled: b.disabled,
          title: b.title,
        }));
        return buttons;
      `);
      if (found === null) throw new Error("the project is listed but drew no row");
      const labels = found.map((b) => b.label);
      for (const needed of ["install", "export", "rename", "remove"]) {
        if (!labels.includes(needed)) throw new Error(`the row has no ${needed} button (${labels.join(", ")})`);
      }
      const install = found.find((b) => b.label === "install");
      if (install.disabled) throw new Error("install is disabled on a project whose folder is there");
      if (!/dependencies/.test(install.title)) throw new Error(`install does not say what it does: ${install.title}`);
      return `row: ${labels.join(" · ")}`;
    } finally {
      // Gone again, and its folder with it: a layout check must not leave a project
      // behind in whatever workspace it was pointed at.
      await fetch(`${base}/api/projects/${encodeURIComponent(project.id)}?files=delete`, {
        method: "DELETE",
        headers,
      });
    }
  });

  await check("a deep link's panel is not robbed of focus by the composer", async () => {
    await send("Page.navigate", { url: `${base}/?settings=appearance` });
    const booted = await waitFor("document.querySelector('.composer-hint')");
    if (!booted) throw new Error("the console did not boot on the deep link");
    const at = await evaluate(`
      const panel = document.querySelector('#appearance');
      const el = document.activeElement;
      return {
        open: !panel.classList.contains('hidden'),
        inside: el !== null && panel.contains(el),
        where: el === null ? "none" : (el.id || el.tagName.toLowerCase()),
      };
    `);
    if (!at.open) throw new Error("?settings=appearance did not open the panel");
    if (!at.inside) throw new Error(`focus is on ${at.where} — the composer took it back`);
    return "focus is in the panel the link opened";
  });

  /* --------------------------------------------------------------- folds -- */

  console.log("\nFoldable sections (desktop, real clicks)");

  /*
   * A fold is three promises, and this drives all three with the browser rather
   * than reading the markup: a click on the header opens the block it names, a
   * closed block's controls are out of the tab order (they are not rendered, and
   * a control that is invisible but still tabbable is the failure this style of
   * disclosure is prone to), and what was folded survives a reload.
   *
   * The Remote panel is where the defaults matter most — three alternative forms,
   * one of them open — so it is the one unfolded here, and the sidebar's status
   * rows are folded, because that is the one a person folds to give the chat list
   * more room.
   */
  await check("a block opens on a real click, and a closed one is out of the tab order", async () => {
    await send("Page.navigate", { url: `${base}/` });
    const booted = await waitFor("document.querySelector('.composer-hint')");
    if (!booted) throw new Error("the console did not boot");

    // The panel's door is in the workspace panel, the same two clicks a person
    // makes (`ui:smoke` walks them the same way).
    await clickControl("#toggle-files");
    await clickControl("#remote-open");
    const opened = await waitFor(
      `!document.querySelector('#remote').classList.contains('hidden')`,
      5_000,
    );
    if (!opened) throw new Error("the remote panel did not open");

    /*
     * The question is *focusability*, not geometry, and the difference was worth
     * measuring: Chromium lays a closed block's controls out — they have a box,
     * and `offsetParent` is the panel — but refuses them focus. `checkVisibility`
     * and a real `focus()` are the two facts that matter, because a control the
     * browser will not focus is one the modal's Tab trap must not count.
     */
    const before = await evaluate(`
      const section = document.querySelector('#section-remote-atlas');
      const field = document.querySelector('#remote-atlas-repo');
      field.focus();
      return {
        open: section.open,
        rendered: field.checkVisibility(),
        focusable: document.activeElement === field,
        header: document.querySelector('#remote-atlas-heading').textContent.trim(),
      };
    `);
    if (before.open) throw new Error("the Atlas block starts open, so there is nothing to unfold");
    if (before.rendered || before.focusable) {
      throw new Error(
        "a control in a closed block is still rendered and focusable — Tab reaches what nobody can see",
      );
    }

    /*
     * And the Tab trap still holds with those blocks shut, which is the failure a
     * closed block invites: a trap that counted them would take an unreachable
     * control for the panel's last stop and let Tab walk out of the dialog.
     */
    const walk = await tabWalk("#remote", 20);
    if (walk.escaped !== null) throw new Error(walk.escaped);
    if (walk.stops < 6) throw new Error(`Tab reached only ${walk.stops} control(s)`);

    await clickControl("#section-remote-atlas > summary");
    const unfolded = await waitFor("document.querySelector('#section-remote-atlas').open", 5_000);
    if (!unfolded) throw new Error("a click on the block's own header did not open it");
    const shown = await evaluate(`
      const field = document.querySelector('#remote-atlas-repo');
      field.focus();
      return field.checkVisibility() && document.activeElement === field;
    `);
    if (!shown) throw new Error("the block opened but its control still cannot be reached");
    return `“${before.header}” — folded shut, ${walk.stops} stops still inside the dialog, open on one click`;
  });

  await check("what was folded is remembered, and nothing else moved", async () => {
    // Folded through the real control, from the sidebar, with the workspace panel
    // closed again so the click cannot land on an overlay instead of the summary.
    await send("Page.navigate", { url: `${base}/` });
    await waitFor("document.querySelector('.composer-hint')");
    await clickControl("#section-status > summary");
    const folded = await waitFor("document.querySelector('#section-status').open === false", 5_000);
    if (!folded) throw new Error("a click on the status header did not fold the section");

    await send("Page.navigate", { url: `${base}/` });
    await waitFor("document.querySelector('.composer-hint')");
    const after = await evaluate(`return {
      status: document.querySelector('#section-status').open,
      atlas: document.querySelector('#section-remote-atlas').open,
      chats: document.querySelector('#section-chats').open,
      count: document.querySelector('#sessions-count').textContent.trim(),
    };`);
    if (after.status) throw new Error("the section folded a moment ago came back open");
    if (!after.atlas) throw new Error("the block unfolded before it was not remembered");
    if (!after.chats) throw new Error("the chat list, which nobody folded, reloaded folded");
    if (after.count === "") throw new Error("a folded chat list says nothing about what is in it");
    return `folded sections reload folded, chats still open (${after.count})`;
  });

  /* --------------------------------------------------------- reduced motion -- */

  console.log("\nDesktop, prefers-reduced-motion: reduce");
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.navigate", { url: `${base}/` });
  await waitFor("document.querySelector('.composer-hint')");
  const still = await evaluate(PROBE);

  await check("the preference is reported to the page", () => {
    if (!still.media.reducedMotion) throw new Error("the media query does not match");
    return "the stylesheet's block is reachable";
  });

  await check("nothing animates", () => {
    // The drawer's slide is the longest transition in the console; if it is
    // off, the blanket rule reached the page.
    const longest = Math.max(
      ...still.sidebarTransition.split(",").map((part) => parseFloat(part) || 0),
    );
    if (longest > 0.01) throw new Error(`the drawer still slides for ${still.sidebarTransition}`);
    return `drawer transition ${still.sidebarTransition}`;
  });

  await check("the caret still says the answer is arriving", async () => {
    // Stopping the animation must not stop the *signal*: `content` is not an
    // animation, so the mark is still drawn, it simply does not blink.
    const drawn = await evaluate(`
      const probe = document.createElement('div');
      probe.className = 'msg-assistant cursor';
      document.querySelector('#messages').append(probe);
      const content = getComputedStyle(probe, '::after').content;
      probe.remove();
      return content;
    `);
    if (drawn === "none" || drawn === "normal" || drawn === "") {
      throw new Error(`the caret's ::after has no content (${drawn})`);
    }
    return drawn;
  });

  await check("the page never threw", () => {
    if (pageErrors.length > 0) throw new Error(pageErrors.slice(0, 3).join(" | "));
    return "no exceptions and no console errors across four loads";
  });
} finally {
  /*
   * Kill the browser's whole process group, not just the process this script
   * spawned. Chromium's renderer and GPU processes are its children, and they
   * outlive a SIGKILL aimed at the parent — still writing into the profile
   * directory while it is being removed, which failed the run *after* every
   * check had passed and would have failed it in CI too, for nothing.
   */
  try {
    process.kill(-chrome.pid, "SIGKILL");
  } catch {
    chrome.kill("SIGKILL");
  }
  await sleep(300);
  await new Promise((resolve) => server.close(resolve));

  /*
   * The scratch directories are not a check, so failing to remove one is a note
   * rather than a failed run — but it is a note, not silence: something left in
   * the temporary directory is worth seeing.
   */
  for (const [what, target] of [
    ["workspace", workspace],
    ["browser profile", profile],
  ]) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.log(`  note: could not remove the temporary ${what} at ${target} (${error.code})`);
    }
  }
}

if (failures > 0) {
  console.log(`\n${failures} layout check(s) failed.`);
  process.exit(1);
}
console.log("\nThe console adapts: phone, tablet and desktop.");
