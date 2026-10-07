import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

/**
 * The app preview: what gets run, where it is reached, and what happens when it
 * is not there.
 *
 * The pane's promise is "the app, running, updating as it is edited", and every
 * part of it is a thing that can be wrong in a way nobody sees: a detected command
 * that runs the wrong script, a proxy that answers 200 with the console's own root
 * document, a change feed that fires on `node_modules` and reloads the page forty
 * times a second. So the tests here start a real server, fetch a real page through
 * the real proxy, and watch a real directory.
 *
 * The dev server is a four-line script written into the workspace and run with
 * `node`, so none of this depends on npm, a framework or the network.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "genie-preview-"));

process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_DATA_DIR = path.join(workspace, ".agent");
process.env.AGENT_SANDBOX = "host";
process.env.AGENT_APPROVAL = "off";
process.env.WEB_TOKEN = "preview-token";
// Never dialled: nothing here runs a turn, and the import must not either.
process.env.OMNIROUTE_URL = "http://127.0.0.1:9/v1";
process.env.CONTROL_PLANE_INTERNAL_URL = "";
process.env.CONTROL_INTERNAL_TOKEN = "";

const {
  detectPreviewCommand,
  findFreePort,
  portAnswers,
  previewEvents,
  previewStatus,
  resetPreview,
  startPreview,
  stopPreview,
} = await import("../preview.js");
const { createServer } = await import("../server.js");
const { ensureWorkspace } = await import("../workspace.js");

await ensureWorkspace();
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const TOKEN = "preview-token";

after(async () => {
  await resetPreview();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(workspace, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helpers */

const write = (rel: string, content: string): Promise<void> =>
  fs.mkdir(path.dirname(path.join(workspace, rel)), { recursive: true }).then(() =>
    fs.writeFile(path.join(workspace, rel), content, "utf8"),
  );

const remove = (rel: string): Promise<void> =>
  fs.rm(path.join(workspace, rel), { recursive: true, force: true });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The status endpoint, asked until the preview stops saying it is still starting.
 *
 * Polling rather than one fixed wait: the gate opens on the test's command, and
 * how long the fixture then takes to bind is the machine's business, not this
 * test's. A bounded number of attempts so a regression fails rather than hangs.
 */
async function previewSettled(): Promise<{ running: boolean; pending?: boolean; error: string | null }> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const body = (await fetch(`${base}/api/preview?token=${TOKEN}`).then((r) => r.json())) as {
      running: boolean;
      pending?: boolean;
      error: string | null;
    };
    if (body.pending === undefined) return body;
    await sleep(100);
  }
  throw new Error("the preview never stopped reporting that it was still starting");
}

/** A page that asks for a root-relative asset, which is what the rewrite is for. */
const PAGE = `<!doctype html>
<html><head><title>preview fixture</title><base href="/"></head>
<body><script src="/app.js"></script><a href="/about">about</a></body></html>`;

const APP_JS = `window.previewFixture = true;\n`;

/**
 * A module nothing in the page names.
 *
 * Vite asks for `/@vite/client`, Next for `/_next/webpack-hmr`, and a dynamic
 * import is a string a build step produced — none of which the document's own
 * attributes could tell a proxy about. This is that request: an absolute path on
 * the console's origin that only the app knows how to answer.
 */
const RUNTIME_JS = `window.builtAtRuntime = true;\n`;

/**
 * The dev server the workspace runs.
 *
 * It honours `PORT`, listens on the loopback interface, and serves one HTML page
 * plus one script — the smallest project that still exercises the rewrite, the
 * asset proxy and the port handshake.
 */
const SERVER_JS = `
const http = require("http");
const page = ${JSON.stringify(PAGE)};
const app = ${JSON.stringify(APP_JS)};
const runtime = ${JSON.stringify(RUNTIME_JS)};
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/runtime.js")) {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(runtime);
    return;
  }
  if (req.url.startsWith("/app.js")) {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(app);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
});
// A development server's hot reload is a websocket, and it is the one thing a
// proxy cannot serve from a document rewrite.
server.on("upgrade", (req, socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n");
  socket.write("hot-reload-ok");
});
server.listen(Number(process.env.PORT), "127.0.0.1");
`;

/**
 * A dev server that binds only when the workspace says so.
 *
 * A framework's first build holds the port for an unpredictable time, and the
 * "still starting" test used to guess it with `sleep 1.4` against a fixed grace
 * window. Under load that margin is not a margin: if this process is descheduled
 * past the window, the app answers first and the preview is *correctly* reported
 * as up — so the assertion, not the behaviour, was the flake. A gate file takes
 * the clock out of the question: the port stays unbound until the test opens it,
 * however long the machine takes, so "still starting" is what the status must
 * say and nothing can make it look wrong.
 */
const GATED_SERVER_JS = `
const fs = require("fs");
const http = require("http");
const page = ${JSON.stringify(PAGE)};
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
});
// Bind only once the workspace opens the gate — the port is held, deliberately,
// for as long as the test needs it held.
const gate = setInterval(() => {
  if (!fs.existsSync("open.gate")) return;
  clearInterval(gate);
  server.listen(Number(process.env.PORT), "127.0.0.1");
}, 25);
`;

/* ------------------------------------------------------------- detection */

test("what to run", async (t) => {
  const fixture = path.join(workspace, "detect");
  const at = (rel: string): string => path.join(fixture, rel);
  const inFixture = async (rel: string, content: string): Promise<void> => {
    await fs.mkdir(path.dirname(at(rel)), { recursive: true });
    await fs.writeFile(at(rel), content, "utf8");
  };

  await t.test("an empty directory is nothing to run, and says so", async () => {
    await fs.mkdir(at("."), { recursive: true });
    assert.equal(detectPreviewCommand(fixture), null);
  });

  await t.test("a project's own dev script wins", async () => {
    await inFixture("package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    assert.deepEqual(detectPreviewCommand(fixture), { command: "npm run dev", cwd: "." });
  });

  await t.test("start is used when there is no dev", async () => {
    await inFixture("package.json", JSON.stringify({ scripts: { start: "node server.js" } }));
    assert.deepEqual(detectPreviewCommand(fixture), { command: "npm run start", cwd: "." });
  });

  await t.test("an empty or missing script is not a start command", async () => {
    await inFixture("package.json", JSON.stringify({ scripts: { dev: "   " } }));
    await inFixture("index.html", "<html></html>");
    // The blank script is skipped rather than run, and the static page is found.
    assert.deepEqual(detectPreviewCommand(fixture), {
      command: "python3 -m http.server $PORT --bind ${HOST:-127.0.0.1}",
      cwd: ".",
    });
  });

  await t.test("a Django project runs its own server, and reads PORT", async () => {
    await fs.rm(at("."), { recursive: true, force: true });
    await fs.mkdir(at("."), { recursive: true });
    await inFixture("manage.py", "print('x')\n");
    const suggestion = detectPreviewCommand(fixture);
    assert.equal(suggestion?.cwd, ".");
    assert.match(suggestion?.command ?? "", /manage\.py runserver/);
  });

  await t.test("a static site is served from the directory holding its index", async () => {
    await fs.rm(at("."), { recursive: true, force: true });
    await inFixture("public/index.html", "<html></html>");
    assert.deepEqual(detectPreviewCommand(fixture), {
      // The bind address comes from the environment, so a deployment that
      // publishes its preview serves the static site on the published address
      // rather than only on loopback.
      command: "python3 -m http.server $PORT --bind ${HOST:-127.0.0.1}",
      cwd: "public",
    });
  });

  await t.test("a malformed package.json is not fatal", async () => {
    await fs.rm(at("."), { recursive: true, force: true });
    await inFixture("package.json", "{ this is not json");
    await inFixture("index.html", "<html></html>");
    assert.match(detectPreviewCommand(fixture)?.command ?? "", /http\.server/);
  });
});

/* ------------------------------------------------------- start, proxy, stop */

test("the preview, end to end", async (t) => {
  await write("server.js", SERVER_JS);

  await t.test("nothing is running before anything is started", () => {
    const status = previewStatus();
    assert.equal(status.running, false);
    assert.equal(status.port, null);
    assert.equal(status.error, null);
    // Nothing is advertised either: an address for an app that is not running is
    // a URL that refuses, which is worse than no URL.
    assert.equal(status.address, null);
  });

  await t.test("starting runs the project and reports where it landed", async () => {
    const status = await startPreview({ command: "node server.js" });
    assert.equal(status.running, true, status.error ?? "the fixture should have started");
    assert.equal(status.command, "node server.js");
    assert.equal(status.error, null, "a server that answered must not be reported as broken");
    assert.ok(status.port !== null && status.port > 0);
    // The port is not a guess: something is actually listening on it.
    assert.equal(await portAnswers(status.port!), true);
  });

  await t.test("the running app is reachable through /preview/", async () => {
    const response = await fetch(`${base}/preview/?token=${TOKEN}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);

    const body = await response.text();
    assert.match(body, /preview fixture/, "the app's page should be what came back");
    assert.equal(
      body.includes('src="/preview/app.js"'),
      true,
      "a root-relative asset must be moved under the prefix",
    );
    assert.equal(
      body.includes('href="/preview/about"'),
      true,
      "a root-relative link must be moved too",
    );
    // The base is rewritten as well, or it would send every relative URL back to
    // the console's own root.
    assert.match(body, /<base href="\/preview\/">/);
  });

  await t.test("a rewritten asset is proxied as itself, not as the page", async () => {
    const response = await fetch(`${base}/preview/app.js?token=${TOKEN}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /javascript/);
    assert.equal(await response.text(), APP_JS);
  });

  await t.test("a path the bundle builds at runtime reaches the app", async () => {
    // Not in the document, so nothing could have rewritten it: this is the
    // request a framework makes for its own client, or a dynamic import makes
    // for a chunk, and it arrives at the console's root.
    const response = await fetch(`${base}/runtime.js?token=${TOKEN}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /javascript/);
    assert.equal(await response.text(), RUNTIME_JS);

    // A nested one too — `/@vite/client` style, not a file at the root.
    const nested = await fetch(`${base}/node_modules/.vite/deps/react.js?token=${TOKEN}`);
    assert.equal(nested.status, 200);
    assert.match(await nested.text(), /preview fixture/, "the app answers; the console does not");
  });

  await t.test("the console's own routes still win", async () => {
    // The fixture serves `/app.js` as well. The console's shell must keep its
    // asset, or the page that draws the preview would be replaced by the app.
    const response = await fetch(`${base}/app.js`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.notEqual(body, APP_JS, "the console's own script must not be shadowed");
    assert.match(body, /preview|sessionStorage|coding-agent/);

    for (const pathname of ["/", "/style.css", "/login", "/health"]) {
      const kept = await fetch(`${base}${pathname}`);
      assert.equal(kept.status, 200, `${pathname} belongs to the console`);
    }
  });

  await t.test("a websocket upgrade reaches the app", async () => {
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(new URL(base).port), "127.0.0.1", () => {
        socket.write(
          `GET /?token=${TOKEN} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n` +
            "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      let received = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        received += chunk;
        if (received.includes("hot-reload-ok")) {
          socket.destroy();
          resolve(received);
        }
      });
      socket.on("error", reject);
      socket.setTimeout(4_000, () => {
        socket.destroy();
        resolve(received);
      });
    });
    assert.match(answer, /101 Switching Protocols/);
    assert.match(answer, /hot-reload-ok/);
  });

  await t.test("the preview is gated exactly like the API", async () => {
    assert.equal((await fetch(`${base}/preview/`)).status, 401);
    assert.equal((await fetch(`${base}/api/preview`)).status, 401);
  });

  await t.test("the API describes what is running", async () => {
    const response = await fetch(`${base}/api/preview`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    // Asserted through a declared shape rather than an inferred `unknown`: the
    // build image resolves `Response.json()` differently from a developer's
    // node_modules, and a test that only compiles on one of them is not a test.
    const status = (await response.json()) as {
      running: boolean;
      command: string | null;
      port: number | null;
      url: string;
      address: string | null;
    };
    assert.equal(status.running, true);
    assert.equal(status.command, "node server.js");
    assert.ok((status.port ?? 0) > 0);
    assert.equal(status.url, "/preview/");
    // This deployment publishes nothing (the default), so there is no network
    // address to name — the console proxy is the only way in, which is true.
    assert.equal(status.address, null, "an unpublished preview must not name an address");
  });

  await t.test("the change stream is an event stream", async () => {
    const response = await fetch(`${base}/api/preview/events?token=${TOKEN}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    // Reading one frame proves it opened rather than hanging before the headers.
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /: connected/);
    await reader.cancel();
  });

  await t.test("starting again replaces rather than accumulates", async () => {
    const first = previewStatus().port;
    const status = await startPreview({ command: "node server.js" });
    assert.equal(status.running, true);
    // One preview per workspace: the replacement took the same port back, and the
    // old process is gone rather than holding a second one nobody opened.
    assert.equal(status.port, first);
    assert.equal(await portAnswers(status.port!), true);
  });

  await t.test("stopping ends it, and the pane says so rather than erroring", async () => {
    const port = previewStatus().port!;
    const stopped = await stopPreview();
    assert.equal(stopped.running, false);
    assert.equal(await portAnswers(port, 300), false);
    assert.equal(previewStatus().running, false);
    assert.equal(previewStatus().port, null);

    // Idempotent: a second stop is not an error.
    assert.equal((await stopPreview()).running, false);

    const response = await fetch(`${base}/preview/?token=${TOKEN}`);
    assert.equal(response.status, 503, "no preview is an answer, not a crash");
    assert.match(await response.text(), /no preview is running/i);
  });

  await t.test("a project that cannot start reports its output instead of pretending", async () => {
    const status = await startPreview({ command: "echo 'boom: no such module'; exit 3" });
    assert.equal(status.running, false);
    assert.equal(status.exitCode, 3);
    assert.match(status.log, /boom: no such module/);
    assert.match(String(status.error), /exited immediately/);
  });

  await t.test("a server still coming up is starting, not already broken", async () => {
    // The port stays unbound until the workspace opens the gate, the way a
    // framework's first build holds it. Reporting that as an error is what put a
    // "preview is not reachable" page in front of an app that was a moment from
    // working.
    await remove("open.gate");
    await write("gated.js", GATED_SERVER_JS);

    const status = await startPreview({ command: "node gated.js" });
    assert.equal(status.running, true, "it is up; it just has nothing to answer with yet");
    assert.equal(status.pending, true);
    assert.equal(status.error, null, "still building is not a failure");

    // The pane polls the status; once the app binds, the same read stops saying
    // `pending`, which is what lets the frame load the app it was waiting for.
    await write("open.gate", "open");
    const settled = await previewSettled();
    assert.equal(settled.running, true);
    assert.equal(settled.pending, undefined, "answering clears the starting flag");
    assert.equal(settled.error, null);

    const page = await fetch(`${base}/preview/?token=${TOKEN}`);
    assert.equal(page.status, 200, "and now the frame has somewhere to point");
    await stopPreview();
  });

  await t.test("a project in a chosen directory is found where it lives", async () => {
    await write("smoketest/index.html", "<html><body><h1>in a folder</h1></body></html>\n");
    const status = await startPreview({ cwd: "smoketest" });
    assert.equal(status.running, true, status.error ?? "the static site should have started");
    assert.equal(status.cwd, "smoketest");
    assert.equal(status.detected, true, "nothing named this command; it was worked out");
    assert.match(String(status.command), /http\.server/);

    // Ready, not merely started: a detected command starts through a login shell
    // and a `python3` interpreter, so on a loaded machine the port can still be
    // unbound when `startPreview` returns and the status says `pending`. The pane
    // waits that out by polling; asking for the page before it clears is how this
    // asserted against a 502 that meant "starting", not "broken".
    await previewSettled();

    // And it is that directory's page being served, not the workspace root's.
    const response = await fetch(`${base}/preview/?token=${TOKEN}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /in a folder/);
    await stopPreview();
  });

  await t.test("nothing to run is a message, not a stack trace", async () => {
    const empty = path.join(workspace, "empty-project");
    await fs.mkdir(empty, { recursive: true });
    const status = await startPreview({ command: "", cwd: "empty-project" });
    assert.equal(status.running, false);
    assert.match(String(status.error), /nothing here looks like an app/i);
  });
});

/* ------------------------------------------------------------- change feed */

test("the change feed", async (t) => {
  await t.test("a file change is announced once, and noise is not", async () => {
    const events = previewEvents();
    let changes = 0;
    const listener = (): void => {
      changes += 1;
    };
    events.on("change", listener);

    try {
      // A write inside a directory the app never serves must not reload the pane:
      // an `npm install` would otherwise reload it hundreds of times.
      await write("node_modules/noise/index.js", "module.exports = 1;\n");
      await write(".git/index", "not really a git index\n");
      await sleep(350);
      const noise = changes;
      assert.equal(noise, 0, `ignored paths announced ${noise} change(s)`);

      await write("index.html", "<html>changed</html>\n");
      await sleep(350);
      assert.ok(changes > noise, "a real edit should announce a change");
    } finally {
      events.off("change", listener);
      await remove("node_modules");
      await remove(".git");
    }
  });

  await t.test("the last listener leaving closes the watcher", async () => {
    // Proved by the absence of a leak rather than by inspecting the watcher: a
    // subscription taken after the first was fully released still works, which it
    // would not if the torn-down watcher were reused.
    const first = previewEvents();
    let seen = 0;
    const listener = (): void => {
      seen += 1;
    };
    first.on("change", listener);
    first.off("change", listener);

    const second = previewEvents();
    let again = 0;
    const other = (): void => {
      again += 1;
    };
    second.on("change", other);
    try {
      await write("second.txt", "hello\n");
      await sleep(350);
      assert.equal(again > 0, true, "a fresh subscription must still hear changes");
    } finally {
      second.off("change", other);
      await remove("second.txt");
    }
  });
});

/* -------------------------------------------------------------- port choice */

test("ports", async (t) => {
  await t.test("a busy port is not handed out", async () => {
    const taken = await findFreePort(0);
    const held = http.createServer(() => undefined);
    await new Promise<void>((resolve) => held.listen(taken, "127.0.0.1", resolve));
    try {
      const chosen = await findFreePort(taken);
      assert.notEqual(chosen, taken, "the port already in use must not be preferred");
      assert.ok(chosen > 0, "a port the caller can actually listen on is required");
    } finally {
      await new Promise<void>((resolve) => held.close(() => resolve()));
    }
  });

  await t.test("a free port is preferred over a random one", async () => {
    const preferred = await findFreePort(0);
    assert.equal(await findFreePort(preferred), preferred);
  });

  await t.test("no preference is not port zero", async () => {
    // Handing "0" back would ask an app to listen somewhere the proxy could never
    // reach, so a request for any port has to produce a real one.
    assert.ok((await findFreePort(0)) > 0);
  });
});
