#!/usr/bin/env node
/**
 * Browser smoke test for the UI, driven over the Chrome DevTools Protocol.
 *
 *   npm run ui:smoke
 *
 * There is no build step and no DOM test runner here on purpose, which leaves
 * one gap: `node --check` proves the client *parses* but not that it runs. This
 * opens the real UI in a real Chromium, clicks the things a person would click,
 * and fails if the DOM code throws.
 *
 * It needs a browser to already be on the machine (Playwright's download is what
 * this host has) and a running agent:
 *
 *   AGENT_UI_URL   default http://127.0.0.1:3400
 *   WEB_TOKEN      read from the environment, then from .env
 *   CHROME_PATH    only if the browser is somewhere unusual
 *
 * Uses Node's built-in WebSocket, so there is nothing to install.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = (process.env.AGENT_UI_URL ?? "http://127.0.0.1:3400").replace(/\/+$/, "");
const ROOT = path.resolve(import.meta.dirname, "..");

/** Minimal .env reader, mirroring src/config.ts. */
function envFromFile(key) {
  try {
    const raw = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match && match[1] === key) return (match[2] ?? "").trim();
    }
  } catch {
    /* no .env is fine */
  }
  return "";
}

const TOKEN = process.env.WEB_TOKEN ?? envFromFile("WEB_TOKEN");

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

  // Newest Playwright build first.
  return candidates.sort().reverse().find((candidate) => fs.existsSync(candidate)) ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ CDP ---- */

class Session {
  #socket;
  #nextId = 1;
  #pending = new Map();
  /** Runtime exceptions and console errors seen while the page was open. */
  pageErrors = [];

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params?.exceptionDetails;
        this.pageErrors.push(details?.exception?.description ?? details?.text ?? "unknown exception");
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
        this.pageErrors.push(
          (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" "),
        );
      }
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Run an expression in the page and bring the value back. */
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
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

  /** Wait for an expression to become truthy. */
  async waitFor(expression, timeoutMs = 60_000, intervalMs = 400) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.evaluate(`return Boolean(${expression});`)) return true;
      if (Date.now() > deadline) return false;
      await sleep(intervalMs);
    }
  }

  close() {
    this.#socket.close();
  }
}

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
        return new Session(socket);
      }
    } catch {
      /* the browser is still starting */
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the browser's debug endpoint");
    await sleep(300);
  }
}

/* --------------------------------------------------------------- checks ---- */

let failures = 0;
let checks = 0;

async function check(label, fn) {
  checks += 1;
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

/* ----------------------------------------------------------------- main ---- */

const chromePath = findChrome();
if (chromePath === null) {
  console.log("No Chromium found. Install one (Playwright downloads to ~/.cache/ms-playwright)");
  console.log("or point CHROME_PATH at a chrome binary. Skipping the UI smoke test.");
  process.exit(0);
}

const health = await fetch(`${BASE}/api/health`, {
  headers: TOKEN === "" ? {} : { Authorization: `Bearer ${TOKEN}` },
})
  .then((response) => response.json())
  .catch(() => null);

if (health === null) {
  console.error(`Could not reach the agent at ${BASE}. Start it first: npm start`);
  process.exit(1);
}
if (health.authRequired && TOKEN === "") {
  console.error("The server requires WEB_TOKEN and none was found in the environment or .env.");
  process.exit(1);
}

const approvalOn = (health.approval?.mode ?? "off") !== "off";
console.log(`Browser   ${chromePath}`);
console.log(`UI        ${BASE}`);
console.log(`Approval  ${health.approval?.mode ?? "off"}${approvalOn ? " (will exercise the prompt)" : ""}`);
console.log(`Sandbox   ${health.sandbox?.backend ?? "unknown"}`);
console.log(
  `Offline   ${health.offline ? `${(health.offline.models ?? []).join(", ")} @ ${health.offline.url}` : "not configured"}`,
);
console.log(`Chain     ${(health.fallbackModels ?? []).join(", ") || "none"}\n`);

const port = 9400 + Math.floor(Math.random() * 400);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ui-smoke-"));
const url = `${BASE}/${TOKEN === "" ? "" : `?token=${encodeURIComponent(TOKEN)}`}`;

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--window-size=1400,900",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    url,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let session = null;
try {
  session = await connect(port);
  await session.send("Runtime.enable");
  await session.send("Page.enable");

  const booted = await session.waitFor(`document.querySelector('#gateway-label')`);
  if (!booted) throw new Error("the UI never rendered");

  await check("the app boots and reaches its own API", async () => {
    const label = await session.evaluate("return document.querySelector('#gateway-label').textContent;");
    if (/unreachable|token/i.test(label)) throw new Error(`status says: ${label}`);
    return label;
  });

  await check("the workspace tree loads", async () => {
    const count = await session.evaluate("return document.querySelectorAll('#files-list .file-entry').length;");
    if (!count) throw new Error("no entries rendered");
    return `${count} entries`;
  });

  await check("files the agent changed are marked", async () => {
    const marked = await session.evaluate(
      "return [...document.querySelectorAll('.file-entry.changed')].map((b) => b.textContent.trim());",
    );
    if (!Array.isArray(marked) || marked.length === 0) throw new Error("nothing is marked as changed");
    return marked.slice(0, 3).join(", ");
  });

  await check("opening a changed file lands on its diff", async () => {
    const opened = await session.evaluate(`
      const button = document.querySelector('.file-entry.changed');
      if (!button) return false;
      button.click();
      return true;
    `);
    if (!opened) throw new Error("no changed file to open");

    const rendered = await session.waitFor(
      `!document.querySelector('#viewer').classList.contains('hidden') &&
       document.querySelectorAll('#viewer-diff .diff-line').length > 0`,
      15_000,
    );
    if (!rendered) throw new Error("the diff view did not render");
    return `${await session.evaluate("return document.querySelectorAll('#viewer-diff .diff-line').length;")} diff lines`;
  });

  await check("the viewer toggles between diff and file", async () => {
    await session.evaluate("document.querySelector('#viewer-toggle').click();");
    const fileShown = await session.waitFor(
      `document.querySelector('#viewer-diff').classList.contains('hidden') &&
       !document.querySelector('#viewer-body').classList.contains('hidden')`,
      5_000,
    );
    if (!fileShown) throw new Error("the raw file did not appear");

    await session.evaluate("document.querySelector('#viewer-toggle').click();");
    const diffShown = await session.waitFor(
      `!document.querySelector('#viewer-diff').classList.contains('hidden')`,
      5_000,
    );
    if (!diffShown) throw new Error("the diff did not come back");

    await session.evaluate("document.querySelector('#viewer-close').click();");
    const closed = await session.waitFor(
      `document.querySelector('#viewer').classList.contains('hidden')`,
      5_000,
    );
    if (!closed) throw new Error("the viewer did not close");
    return "diff -> file -> diff -> close";
  });

  await check("the model selector is populated", async () => {
    const options = await session.evaluate("return document.querySelector('#model').options.length;");
    if (options < 2) throw new Error(`only ${options} option(s)`);
    return `${options} models, default ${await session.evaluate("return document.querySelector('#model').value;")}`;
  });

  await check(`the approval badge matches the config (${health.approval?.mode ?? "off"})`, async () => {
    const hidden = await session.evaluate(
      "return document.querySelector('#approval-badge').classList.contains('hidden');",
    );
    if (approvalOn && hidden) throw new Error("approval is on but the badge is hidden");
    if (!approvalOn && !hidden) throw new Error("approval is off but the badge is showing");
    return approvalOn
      ? await session.evaluate("return document.querySelector('#approval-badge').textContent;")
      : "hidden, as configured";
  });

  await check("the sandbox status reflects the running config", async () => {
    const text = await session.evaluate("return document.querySelector('#sandbox-label').textContent;");
    const expected = health.sandbox?.backend === "docker" ? "sandboxed" : "host";
    if (!text.includes(expected)) throw new Error(`label says "${text}", expected "${expected}"`);
    return text;
  });

  await check('the offline fallback status reflects the config', async () => {
    const text = await session.evaluate("return document.querySelector('#offline-label').textContent;");
    if (health.offline) {
      const expected = (health.offline.models ?? []).join(", ") || health.offline.url;
      if (!text.includes(expected)) throw new Error(`label says "${text}", expected "${expected}"`);
      return `${text} (configured)`;
    }
    if (/checking/i.test(text)) throw new Error(`label still says "${text}"`);
    return `${text} (none configured)`;
  });

  await check("the model health row reflects the last check", async () => {
    const text = await session.evaluate("return document.querySelector('#models-label').textContent;");
    if (/checking/i.test(text)) throw new Error(`still says "${text}"`);
    // The page re-reads health on a timer, so a check may have run between this
    // script's own fetch and the render: accept any well-formed state.
    if (!/^models \d+\/\d+ ready$/.test(text) && !/chain check off|not checked yet/.test(text)) {
      throw new Error(`label says "${text}", which is not a state this row renders`);
    }
    return text;
  });

  await check("the per-chat offline opt-out is present and labelled", async () => {
    const box = await session.evaluate(`const el = document.querySelector('#use-offline');
      return { present: Boolean(el), checked: el?.checked ?? false, disabled: el?.disabled ?? true, labels: el?.labels?.length ?? 0 };`);
    if (!box.present) throw new Error("the opt-out checkbox is missing");
    if (box.labels === 0) throw new Error("the checkbox has no label");
    if (Boolean(health.offline) === box.disabled) {
      throw new Error(`disabled=${box.disabled} but an offline gateway is ${health.offline ? "" : "not "}configured`);
    }
    return health.offline ? `enabled, checked=${box.checked}` : "disabled, as nothing is configured";
  });

  await check("the chain box shows the chain the server would use", async () => {
    const value = await session.evaluate("return document.querySelector('#fallbacks').value;");
    const expected = (health.fallbackModels ?? []).join(",");
    if (value !== expected) throw new Error(`chain box shows "${value}", expected "${expected}"`);
    return value === "" ? "empty, as configured" : value;
  });

  await check("the model sweep panel opens and mirrors the server's last sweep", async () => {
    await session.evaluate("document.querySelector('#sweep-open').click();");
    const opened = await session.waitFor(
      `!document.querySelector('#sweep').classList.contains('hidden')`,
      5_000,
    );
    if (!opened) throw new Error("the sweep dialog did not open");

    // Opening re-reads the last sweep before it renders, so wait for a status.
    const settled = await session.waitFor(
      `document.querySelector('#sweep-status').textContent.trim() !== ''`,
      10_000,
    );
    if (!settled) throw new Error("the sweep status line stayed empty");

    // Read the same endpoint the panel read, from inside the page (the token
    // lives in sessionStorage by now; the UI strips it from the address bar).
    const panel = await session.evaluate(`
      const token = sessionStorage.getItem('coding-agent-token') ?? '';
      return fetch('/api/models/sweep', {
        headers: token === '' ? {} : { Authorization: 'Bearer ' + token },
      })
        .then((response) => response.json())
        .then((payload) => ({
          status: document.querySelector('#sweep-status').textContent.trim(),
          sections: document.querySelectorAll('#sweep-report .sweep-section').length,
          running: payload.sweep.running === true,
          total: payload.sweep.total,
          results: Array.isArray(payload.sweep.results) ? payload.sweep.results.length : 0,
        }));`);

    const expected = panel.running
      ? "probing "
      : panel.results === 0
        ? "Not run yet"
        : `${panel.results} can drive the agent`;
    if (!panel.status.includes(expected)) {
      throw new Error(
        `status says "${panel.status}", but the server reports ${JSON.stringify(panel)}`,
      );
    }
    // The report is the point of the panel, so a finished sweep rendering nothing
    // would mean the render silently did nothing.
    if (panel.results > 0 && panel.sections === 0) {
      throw new Error("the sweep has results, but the report rendered no sections");
    }
    return panel.status;
  });

  await check("the sweep panel is a labelled dialog that Escape closes", async () => {
    const shape = await session.evaluate(`
      const dialog = document.querySelector('#sweep');
      return {
        hidden: dialog.classList.contains('hidden'),
        role: dialog.getAttribute('role'),
        modal: dialog.getAttribute('aria-modal'),
        labelled:
          dialog.getAttribute('aria-labelledby') === 'sweep-title' &&
          (document.querySelector('#sweep-title')?.textContent ?? '') !== '',
        buttons: ['#sweep-run', '#sweep-run-all', '#sweep-close'].every((selector) =>
          document.querySelector(selector) !== null,
        ),
      };`);

    if (shape.hidden) throw new Error("the panel was already closed by the previous check");
    if (shape.role !== "dialog" || shape.modal !== "true") {
      throw new Error(`role=${shape.role} aria-modal=${shape.modal}`);
    }
    if (!shape.labelled) throw new Error("the dialog has no labelled title");
    if (!shape.buttons) throw new Error("a run or close button is missing");

    await session.evaluate(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;`);
    const escaped = await session.waitFor(
      `document.querySelector('#sweep').classList.contains('hidden')`,
      5_000,
    );
    if (!escaped) throw new Error("Escape did not close the sweep panel");

    // And the close button, which is the way most people will do it.
    await session.evaluate("document.querySelector('#sweep-open').click();");
    await session.waitFor(`!document.querySelector('#sweep').classList.contains('hidden')`, 5_000);
    await session.evaluate("document.querySelector('#sweep-close').click();");
    const closed = await session.waitFor(
      `document.querySelector('#sweep').classList.contains('hidden')`,
      5_000,
    );
    if (!closed) throw new Error("the close button did not close it");
    return "opens, labelled, closes on Escape and on the button";
  });

  /**
   * A sweep whose answer never reaches the picker leaves the report to be
   * copy-pasted by hand, which is the thing it exists to stop. Both render from
   * the same state, so they have to agree.
   */
  await check("the models the sweep proved usable are reachable from the picker", async () => {
    const response = await fetch(`${BASE}/api/models/sweep`, {
      headers: TOKEN === "" ? {} : { Authorization: `Bearer ${TOKEN}` },
    });
    const { sweep } = await response.json();
    const usable = (sweep?.results ?? [])
      .filter((result) => result.ok)
      .map((result) => result.model);
    if (usable.length === 0) return "the last report has no usable models";

    const shape = await session.evaluate(`
      document.querySelector('#sweep-open').click();
      return {
        rows: [...document.querySelectorAll('#sweep-report .sweep-row')].map((row) => ({
          model: row.querySelector('.sweep-model').textContent.trim(),
          use: row.querySelector('.sweep-use') !== null,
        })),
      };`);

    for (const model of usable) {
      const row = shape.rows.find((entry) => entry.model.includes(model));
      if (row === undefined) throw new Error(`${model} is usable but missing from the report`);
      if (!row.use) throw new Error(`${model} is usable but offers no way to select it`);
    }

    const marked = await session.evaluate(`
      const usable = ${JSON.stringify(usable)};
      const options = [...document.querySelectorAll('#model option')];
      return usable.filter((model) =>
        options.some((option) => option.value === model && option.textContent.includes('✓')),
      ).length;`);

    await session.evaluate("document.querySelector('#sweep-close').click();");
    if (marked < usable.length) {
      throw new Error(`${usable.length - marked} usable model(s) are unmarked in the picker`);
    }
    return `${usable.length} usable model(s) marked and selectable`;
  });

  /**
   * The preview pane is where a file is watched while it is being written. A
   * turn only opens it when a draft arrives, so what is checked here is the
   * structure and the manual toggle - the drafting itself is covered by the
   * server tests, which can script a stream that arrives in fragments.
   */
  await check("the preview pane opens, closes and describes itself", async () => {
    const closed = await session.evaluate(`
      document.querySelector('#preview-close').click();
      const pane = document.querySelector('#preview');
      return {
        open: pane.classList.contains('open'),
        expanded: document.querySelector('#toggle-preview').getAttribute('aria-expanded'),
      };`);
    if (closed.open) throw new Error("the close button did not close the preview pane");
    if (closed.expanded !== "false") throw new Error("the toggle still claims the pane is open");

    const opened = await session.evaluate(`
      document.querySelector('#toggle-preview').click();
      const pane = document.querySelector('#preview');
      return {
        open: pane.classList.contains('open'),
        labelled: (pane.getAttribute('aria-label') ?? '') !== '',
        expanded: document.querySelector('#toggle-preview').getAttribute('aria-expanded'),
        title: document.querySelector('#preview-title').textContent.trim(),
        body: document.querySelector('#preview-body').textContent,
        toggleHidden: document.querySelector('#preview-toggle').classList.contains('hidden'),
      };`);

    if (!opened.open || opened.expanded !== "true") throw new Error("the toggle did not open the pane");
    if (!opened.labelled) throw new Error("the pane has no accessible name");

    // Either nothing has been generated yet, or the pane is holding the last file
    // the agent produced - an empty pane claiming a file would be the bug.
    const empty = opened.title === "nothing generated yet";
    if (empty && opened.body !== "") {
      throw new Error(`the pane says nothing was generated, but shows ${opened.body.length} characters`);
    }
    if (!empty && opened.body.trim() === "") {
      throw new Error(`the pane is titled ${opened.title} but has no content`);
    }
    // With no change to show there is nothing for the change/code button to do.
    if (empty && !opened.toggleHidden) {
      throw new Error("the show-change button is offered with no code on screen");
    }
    return empty ? "opens empty, closes, labelled" : `opens on ${opened.title}`;
  });

  await check("accessibility basics are present", async () => {
    const missing = await session.evaluate(`
      const want = [
        ['.skip-link', 'skip link'],
        ['#input[aria-label]', 'labelled composer'],
        ['#messages[role="log"]', 'conversation as a log'],
        ['#live[aria-live="polite"]', 'live region'],
        ['#viewer[role="dialog"][aria-modal="true"]', 'viewer dialog'],
        ['#sessions[aria-label]', 'labelled session list'],
        ['#fallbacks[aria-label]', 'labelled fallback chain'],
        ['#use-offline', 'labelled offline opt-out'],
        ['#sweep[role="dialog"][aria-modal="true"]', 'sweep dialog'],
        ['#sweep-open[title]', 'labelled sweep button'],
        ['#preview[aria-label]', 'labelled preview pane'],
        ['#toggle-preview[aria-controls="preview"]', 'preview toggle bound to the pane'],
        ['#preview-status[role="status"]', 'preview status line'],
      ];
      return want.filter(([selector]) => !document.querySelector(selector)).map(([, name]) => name);
    `);
    if (missing.length > 0) throw new Error(`missing: ${missing.join(", ")}`);
    return "skip link, labels, live region, dialog roles";
  });

  /**
   * Wait for a turn to finish. The composer refuses input while streaming, so
   * submitting too early is silently dropped - which looks exactly like the app
   * being broken.
   */
  async function waitForIdle(timeoutMs = 240_000) {
    const idle = await session.waitFor(
      `!document.querySelector('#send').classList.contains('hidden') &&
       document.querySelector('#stop').classList.contains('hidden')`,
      timeoutMs,
    );
    if (!idle) throw new Error("the turn never finished");
  }

  if (approvalOn) {
    /**
     * Ask for a command, wait for its prompt, answer it, and hand back the
     * prompt's summary. Counts the cards first so it always acts on the newest
     * one rather than an earlier prompt still in the transcript.
     */
    async function approvalTurn(prompt, decision) {
      await waitForIdle();

      const before = await session.evaluate(
        "return document.querySelectorAll('.approval').length;",
      );

      await session.evaluate(`
        const input = document.querySelector('#input');
        input.value = ${JSON.stringify(prompt)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
      `);

      const asked = await session.waitFor(
        `document.querySelectorAll('.approval').length > ${before}`,
        180_000,
      );
      if (!asked) throw new Error("no approval card appeared");

      const summary = await session.evaluate(
        "return [...document.querySelectorAll('.approval')].at(-1).querySelector('.approval-summary').textContent;",
      );

      const button = decision === "approve" ? ".btn-primary" : ".btn-danger";
      const settledClass = decision === "approve" ? "approved" : "denied";
      await session.evaluate(
        `[...document.querySelectorAll('.approval')].at(-1).querySelector('${button}').click();`,
      );

      const settled = await session.waitFor(
        `[...document.querySelectorAll('.approval')].at(-1).classList.contains('${settledClass}')`,
        30_000,
      );
      if (!settled) throw new Error(`the card did not record the ${decision}`);

      // Let the model finish its follow-up so the transcript is settled.
      await waitForIdle();
      return summary;
    }

    await check("denying a command stops it from running", async () => {
      const summary = await approvalTurn(
        "Run this shell command and report the output: echo ui-smoke-should-not-run",
        "deny",
      );

      const refused = await session.waitFor(
        `[...document.querySelectorAll('.tool-body')].some((n) => /denied/i.test(n.textContent))`,
        60_000,
      );
      if (!refused) throw new Error("the refusal never appeared in the transcript");

      const ran = await session.evaluate(
        "return [...document.querySelectorAll('.tool-body')].some((n) => n.textContent.includes('ui-smoke-should-not-run') && !/denied/i.test(n.textContent));",
      );
      if (ran) throw new Error("the denied command ran anyway");

      return summary;
    });

    await check("approving a command runs it, in the sandbox", async () => {
      const marker = `ui-smoke-approved-${Math.random().toString(36).slice(2, 8)}`;
      const summary = await approvalTurn(
        `Run exactly this shell command with run_command, then stop: echo ${marker}`,
        "approve",
      );

      const executed = await session.waitFor(
        `[...document.querySelectorAll('.tool-body')].some((n) => n.textContent.includes('${marker}'))`,
        120_000,
      );
      if (!executed) throw new Error("the approved command produced no output in the transcript");

      if (health.sandbox?.backend === "docker") {
        const inContainer = await session.evaluate(
          `return [...document.querySelectorAll('.tool-body')].some((n) => n.textContent.includes('${marker}') && /ran in container/.test(n.textContent));`,
        );
        if (!inContainer) throw new Error("it ran, but not inside the sandbox container");
        return `${summary} → output confirmed inside the container`;
      }
      return `${summary} → output confirmed (host backend)`;
    });
  } else {
    console.log("  – skipping the approval flow (AGENT_APPROVAL is off)");
  }

  /**
   * The pane is fed by events that exist only during a turn, so what it shows has
   * to be recoverable from the transcript afterwards - otherwise a reload leaves an
   * empty pane beside a conversation that plainly wrote a file. This runs one real
   * write through the UI and then reloads the page.
   */
  await check("a written file is previewed live, highlighted, and restored after a reload", async () => {
    await waitForIdle();

    /**
     * Wait for the turn, answering any approval it asks for.
     *
     * The prompt tells the model not to run anything, but a model that wants to
     * try its own file will ask to, and a prompt nobody answers parks the turn and
     * fails this check for the wrong reason. What it would run is a python script
     * in the sandbox, which the suite already does elsewhere.
     */
    async function waitForIdleApproving(timeoutMs = 300_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const done = await session.evaluate(
          `return !document.querySelector('#send').classList.contains('hidden') &&
           document.querySelector('#stop').classList.contains('hidden');`,
        );
        const sample = await session.evaluate(`
          return {
            live: document.querySelector('#preview').classList.contains('live'),
            rows: document.querySelectorAll('#preview-diff .diff-line').length,
          };`);
        if (sample.live) liveSeen.live = true;
        liveSeen.rows = Math.max(liveSeen.rows, sample.rows ?? 0);
        if (done) return true;
        await session.evaluate(`
          const waiting = [...document.querySelectorAll('.approval')]
            .filter((card) => card.dataset.settled !== '1');
          for (const card of waiting) card.querySelector('.btn-primary')?.click();
          return waiting.length;`);
        if (Date.now() > deadline) return false;
        await sleep(500);
      }
    }

    // The live diff only exists while the write is arriving, so it has to be
    // sampled during the turn rather than read afterwards.
    const liveSeen = { live: false, rows: 0 };

    const marker = `preview-${Math.random().toString(36).slice(2, 8)}`;
    const prompt =
      "Use write_file to create ui_smoke_preview.py containing exactly these two lines: " +
      `# ${marker}\\nprint("${marker}"). Then stop - do not run anything.`;

    await session.evaluate(`
      const input = document.querySelector('#input');
      input.value = ${JSON.stringify(prompt)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;`);

    if (!(await waitForIdleApproving())) throw new Error("the write turn never finished");

    const live = await session.evaluate(`
      const body = document.querySelector('#preview-body');
      return {
        open: document.querySelector('#preview').classList.contains('open'),
        title: document.querySelector('#preview-title').textContent.trim(),
        text: body.textContent,
        tokens: body.querySelectorAll('[class^="tok-"]').length,
        chat: document.querySelector('#chat-title').textContent.trim(),
      };`);

    if (!live.title.includes(".py")) {
      // The model did not write a file, so there is nothing to check this time.
      return `skipped: the model wrote no file (pane shows \"${live.title}\")`;
    }
    if (!live.open) throw new Error("the pane did not open by itself when the draft arrived");
    if (!live.text.includes(marker)) throw new Error(`the pane does not show the file's contents (${marker})`);
    if (live.tokens === 0) throw new Error("the preview was not highlighted");

    // Reload: the same tab, the same token, an empty module state.
    await session.send("Page.reload");
    const back = await session.waitFor(
      `document.querySelector('#composer') !== null && document.querySelectorAll('.session').length > 0`,
      30_000,
    );
    if (!back) throw new Error("the page did not come back after the reload");

    const reopened = await session.evaluate(`
      const want = ${JSON.stringify(live.chat.slice(0, 24))};
      const button = [...document.querySelectorAll('.session')].find((node) =>
        (node.querySelector('.session-title')?.textContent ?? '').startsWith(want));
      if (button === undefined) return false;
      button.click();
      return true;`);
    if (!reopened) throw new Error(`the chat \"${live.chat}\" is not in the sidebar after a reload`);

    const restored = await session.waitFor(
      `document.querySelector('#preview-title').textContent.trim() === ${JSON.stringify(live.title)} &&
       document.querySelector('#preview-body').textContent.includes(${JSON.stringify(marker)})`,
      30_000,
    );
    if (!restored) {
      const now = await session.evaluate(
        `return document.querySelector('#preview-title').textContent.trim() + " | " +
         document.querySelector('#preview-body').textContent.slice(0, 60);`,
      );
      throw new Error(`the pane came back as: ${now}`);
    }

    // A whole call can arrive in one frame, in which case there is no window in
    // which a diff could stream: report what was seen rather than failing on it.
    const liveNote = liveSeen.live
      ? `live diff streamed (${liveSeen.rows} rows at its peak)`
      : "no mid-write window (the model sent the whole call at once)";

    return `${live.title} — ${live.tokens} highlighted tokens, restored from the transcript; ${liveNote}`;
  });

  /**
   * The change half of the pane, and deleting a file from the workspace.
   *
   * The check before this one wrote `ui_smoke_preview.py`, so this removes it:
   * the suite aims to leave the workspace as it found it. The two clicks are the
   * point - the first arms the button, the second deletes, and nothing happens on
   * one click alone.
   */
  await check("the change is shown, and a file can be deleted from the viewer", async () => {
    await waitForIdle();

    const scratch = "ui_smoke_preview.py";
    const inTree = await session.evaluate(`
      return [...document.querySelectorAll('#files-list .file-entry')]
        .some((node) => node.textContent.includes(${JSON.stringify(scratch)}));`);
    if (!inTree) return "skipped: the previous check wrote no file to clean up";

    await session.evaluate(`
      const entry = [...document.querySelectorAll('#files-list .file-entry')]
        .find((node) => node.textContent.includes(${JSON.stringify(scratch)}));
      entry.click();
      return true;`);

    const opened = await session.waitFor(
      `!document.querySelector('#viewer').classList.contains('hidden') &&
       document.querySelector('#viewer-title').textContent.includes(${JSON.stringify(scratch)})`,
      10_000,
    );
    if (!opened) throw new Error("the scratch file did not open in the viewer");

    // A file the agent created should land on its change; if it did not, ask.
    if ((await session.evaluate("return document.querySelectorAll('#viewer-diff .diff-line').length;")) === 0) {
      await session.evaluate(`
        const toggle = document.querySelector('#viewer-toggle');
        if (!toggle.classList.contains('hidden') && toggle.textContent.trim() === 'show diff') toggle.click();
        return true;`);
      const shown = await session.waitFor(
        `document.querySelectorAll('#viewer-diff .diff-line').length > 0`,
        10_000,
      );
      if (!shown) throw new Error("a newly created file has no change to show");
    }
    const rows = await session.evaluate("return document.querySelectorAll('#viewer-diff .diff-line').length;");

    await session.evaluate("document.querySelector('#viewer-delete').click();");
    const armed = await session.evaluate(`
      const button = document.querySelector('#viewer-delete');
      return { armed: button.classList.contains('armed'), text: button.textContent.trim() };`);
    if (!armed.armed) throw new Error("one click deleted without asking");
    if (!/confirm/i.test(armed.text)) throw new Error(`the armed button says "${armed.text}"`);

    await session.evaluate("document.querySelector('#viewer-delete').click();");
    const gone = await session.waitFor(
      `document.querySelector('#viewer').classList.contains('hidden') &&
       ![...document.querySelectorAll('#files-list .file-entry')]
         .some((node) => node.textContent.includes(${JSON.stringify(scratch)}))`,
      15_000,
    );
    if (!gone) throw new Error("the file was not removed from the workspace");

    // Really gone, not merely missing from the tree the page last drew.
    const second = await session.evaluate(`
      const token = sessionStorage.getItem('coding-agent-token') ?? '';
      return fetch('/api/file?path=' + encodeURIComponent(${JSON.stringify(scratch)}), {
        method: 'DELETE',
        headers: token === '' ? {} : { Authorization: 'Bearer ' + token },
      }).then((response) => response.status);`);
    if (second !== 404) throw new Error(`a second delete returned ${second}, not 404`);

    return `${rows} change rows shown, then deleted in two clicks`;
  });

  /**
   * The warning shown before a turn is derived from the last health check, so the
   * two have to agree: a chain with something ready must not produce it, or it is
   * noise the user learns to ignore.
   */
  await check("the pre-turn warning agrees with the chain health", async () => {
    const current = await fetch(`${BASE}/api/health`, {
      headers: TOKEN === "" ? {} : { Authorization: `Bearer ${TOKEN}` },
    }).then((response) => response.json());

    const warned = await session.evaluate(
      `return [...document.querySelectorAll('#messages .notice')].some((node) =>
        /could not get a tool call out of anything in the chain/.test(node.textContent));`,
    );

    // Only entries this chat would actually use count, exactly as the server does.
    const relevant = (current.modelHealth?.entries ?? []).filter((entry) => entry.offline !== true);
    const usable = relevant.filter((entry) => entry.ok === true).length;

    if (relevant.length > 0 && usable > 0 && warned) {
      throw new Error(
        `${usable} of ${relevant.length} chain models are ready, but a turn warned that nothing works`,
      );
    }
    return `${usable}/${relevant.length} ready, warning ${warned ? "shown" : "not shown"}`;
  });

  await check("nothing threw in the browser console", async () => {
    const noise = session.pageErrors.filter((entry) => !/favicon/i.test(entry));
    if (noise.length > 0) throw new Error(noise.slice(0, 3).join(" | "));
    return "clean";
  });
} finally {
  session?.close();
  chrome.kill("SIGKILL");
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
