import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Point the registry at a scratch directory and turn previews on before any
// module reads the config. The port range is high and narrow so the tests do not
// race another service on the machine.
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "preview-test-"));
process.env.AGENT_WORKSPACE = scratch;
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");
process.env.PREVIEW_ENABLED = "true";
process.env.PREVIEW_DOMAIN = "genie.innotel.us";
process.env.PREVIEW_BACKEND_HOST = "127.0.0.1";
process.env.PREVIEW_PORT_START = "46200";
process.env.PREVIEW_PORT_END = "46240";
process.env.PREVIEW_TTL_MS = "0";
process.env.AGENT_SANDBOX = "host";
// Magnate is deliberately left unconfigured: a case below proves the refusal when
// no endpoint is set, so the operator's own `.env` — which points at the real
// Magnate on the LAN — must not leak in and configure it, or the case would assert
// the opposite of what it means. Node's env-file loading does not override a
// variable already in the environment, so an explicit empty value wins.
process.env.MAGNATE_ENTITLEMENTS_URL = "";
process.env.ENTITLEMENTS_API_TOKEN = "";

const {
  allocatePort,
  createPreview,
  getPreview,
  isAutoPreviewName,
  listPreviews,
  magnateEntitled,
  normalizePreviewName,
  portIsFree,
  previewLabelFromHost,
  previewPublic,
  proxyPreview,
  removePreview,
  resetPreviewCache,
  resumePreviews,
  stopPreview,
} = await import("../preview-hosting.js");
const { createServer } = await import("../server.js");

const PREVIEW_DOMAIN = "genie.innotel.us";

/**
 * How long a wait is willing to wait.
 *
 * Generous on purpose, because it is the *answer* that is asserted here, never the
 * speed of it. What these waits watch is a real `node` process this suite spawned and a
 * real port it opens, so the time to `listen()` is not something this file controls. The
 * budget used to be two seconds of fixed polling, and that is what the failing CI run
 * shows: it gave up 53ms past two seconds on an address that was about to answer. A
 * child that takes three seconds to reach `listen()` fails that and passes this; a port
 * that never answers still fails, however long the deadline is.
 */
const WAIT_DEADLINE_MS = 20_000;

/** Poll a question until it says yes, or until the deadline passes. */
async function waitUntil(ask: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  for (;;) {
    if (await ask()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Whether something is accepting a connection on a port.
 *
 * A *connection*, not a bind, and that matters more than it looks. Asking "is anything
 * listening?" by binding the port — which is what `portIsFree` does, and what this wait
 * used to ask — means the wait holds the port for the instant between `listen()` and
 * `close()`, and a preview that reaches its own `listen()` inside that instant dies of
 * `EADDRINUSE`, after which no wait is long enough because there is nothing left to
 * serve. It reproduces on demand (hold a port and a child binding it exits 7); it did
 * *not* turn up in forty amplified trials of that loop, so it is not what the CI failure
 * above was — it is a hazard this wait should not carry regardless, because a probe that
 * only connects cannot take the port from the process it is waiting for, and connecting
 * is what a user does, which is the question the test means to ask.
 */
function somethingListening(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
}

/** Wait until something is listening on a port, or give up. */
function waitListening(port: number): Promise<boolean> {
  return waitUntil(() => somethingListening(port));
}

/**
 * Wait until a port is free again, or give up.
 *
 * Free means *bindable*, so this half keeps asking with a bind: `portIsFree` is the
 * question that matches it, and nothing here is racing to take the port.
 */
function waitFree(port: number): Promise<boolean> {
  return waitUntil(() => portIsFree(port));
}

/**
 * The registry a fresh process would find on disk, written by hand.
 *
 * A restart cannot be reproduced from inside the suite — the file survives and
 * the children do not — so the file is written directly and the module cache
 * cleared, which is the state a redeployed container boots into.
 */
async function writeRegistryFile(rows: unknown[]): Promise<void> {
  const dir = path.join(scratch, ".agent");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "previews.json"), JSON.stringify(rows, null, 2));
  resetPreviewCache();
}

/** One registry row, with everything the resume path reads. */
function registryRow(name: string, port: number, command: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    name,
    port,
    host: "127.0.0.1",
    cwd: scratch,
    account: "",
    custom: false,
    command,
    pid: null,
    stopped: false,
    createdAt: now,
    updatedAt: now,
    expiresAt: 0,
  };
}

/** A throwaway upstream that answers every request with its own marker. */
async function startUpstream(marker: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(marker);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** One request with an explicit Host, which fetch() will not let us set. */
function getWithHost(
  port: number,
  host: string,
  urlPath = "/",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method: "GET", headers: { Host: host } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("preview names", async (t) => {
  await t.test("accepts a plain label", () => {
    assert.equal(normalizePreviewName("Acme"), "acme");
    assert.equal(normalizePreviewName("p4001"), "p4001");
  });

  await t.test("refuses a hostname, a reserved name and punctuation", () => {
    assert.throws(() => normalizePreviewName("a.b"), /single label/);
    assert.throws(() => normalizePreviewName("www"), /reserved/);
    assert.throws(() => normalizePreviewName("-bad"), /letters, numbers/);
    assert.throws(() => normalizePreviewName(""), /required/);
  });

  await t.test("tells an auto address from a claimed one", () => {
    assert.equal(isAutoPreviewName("p4001"), true);
    assert.equal(isAutoPreviewName("p1"), false);
    assert.equal(isAutoPreviewName("acme"), false);
  });
});

test("which Host is a preview", async (t) => {
  await t.test("a single label under the wildcard", () => {
    assert.equal(previewLabelFromHost(`p4001.${PREVIEW_DOMAIN}`), "p4001");
    assert.equal(previewLabelFromHost(`p4001.${PREVIEW_DOMAIN}:443`), "p4001");
    assert.equal(previewLabelFromHost(`ACME.${PREVIEW_DOMAIN}.`), "acme");
  });

  await t.test("not the console itself, not a deeper name, not another domain", () => {
    assert.equal(previewLabelFromHost(PREVIEW_DOMAIN), null);
    assert.equal(previewLabelFromHost(`a.b.${PREVIEW_DOMAIN}`), null);
    assert.equal(previewLabelFromHost("genie.ontrak.innotel.us"), null);
    assert.equal(previewLabelFromHost(undefined), null);
  });
});

test("port allocation", async (t) => {
  await t.test("skips a port that is registered", async () => {
    const first = await allocatePort([]);
    const second = await allocatePort([first]);
    assert.notEqual(second, first);
  });

  await t.test("skips a port something is already listening on", async () => {
    const upstream = await startUpstream("busy");
    const chosen = await allocatePort([upstream.port]);
    assert.notEqual(chosen, upstream.port);
    await upstream.close();
  });
});

test("the registry", async (t) => {
  await t.test("an auto address takes the port as its label", async () => {
    resetPreviewCache();
    const preview = await createPreview({ port: 46210 });
    assert.equal(preview.name, "p46210");
    assert.equal(preview.custom, false);

    const found = await getPreview("p46210");
    assert.equal(found?.port, 46210);

    // A second request for the same port is the same preview, not a duplicate.
    const again = await createPreview({ port: 46210 });
    assert.equal(again.name, "p46210");

    assert.equal(await removePreview("p46210"), true);
    assert.equal(await getPreview("p46210"), null);
  });

  await t.test("a custom name needs an entitled subscriber", async () => {
    resetPreviewCache();
    await assert.rejects(
      () => createPreview({ name: "acme", port: 46211 }),
      /subscriber identity/,
    );
  });

  await t.test("a started command gets a pid that stopping clears", async () => {
    resetPreviewCache();
    const preview = await createPreview({ port: 46212, command: "sleep 30" });
    assert.equal(preview.pid !== null, true);
    assert.equal(await stopPreview("p46212"), true);
    const after = await getPreview("p46212");
    assert.equal(after?.pid, null);
    await removePreview("p46212");
  });

  await t.test("republishing an address that is down starts it again", async (t) => {
    resetPreviewCache();
    // This is the one case in the file whose command holds a port, so the child has
    // to be reaped even when an assertion throws above the cleanup: a leaked
    // listener keeps the port and breaks every later run against the same range.
    t.after(async () => {
      await removePreview("p46214");
      assert.equal(await waitFree(46214), true);
    });
    // A command that actually takes the port, so "serving" can be told from
    // "recorded": `startPreviewProcess` hands the child PORT.
    const serve =
      "node -e \"require('net').createServer().listen(Number(process.env.PORT), '127.0.0.1')\"";
    const first = await createPreview({ port: 46214, command: serve, ttlMs: 600_000 });
    assert.equal(await waitListening(46214), true);
    assert.equal(first.pid !== null, true);
    // `createPreview` hands back the registry's own record, and republishing
    // mutates that record in place, so the first TTL has to be copied out here to
    // still mean anything after the republish.
    const firstExpiresAt = first.expiresAt;

    // A duplicate publish of an address that is serving is left alone. The TTL is
    // the observable: the restart path refreshes it, this call did not pass one,
    // so a bounced app would show up as a changed `expiresAt`.
    const again = await createPreview({ port: 46214, command: serve });
    assert.equal(again.pid, first.pid);
    assert.equal(again.expiresAt, first.expiresAt);

    // Now take it down, as a crash or an operator stop would.
    assert.equal(await stopPreview("p46214"), true);
    assert.equal(await waitFree(46214), true);

    // The request a user makes when they press publish again on an address that is
    // not answering. It has to come back serving, not as the record that was dead.
    const republished = await createPreview({ port: 46214, command: serve, ttlMs: 900_000 });
    assert.equal(republished.name, "p46214");
    assert.equal(await waitListening(46214), true);
    // A restart is a fresh publish, so it does not inherit the TTL of the record
    // it replaced.
    assert.equal(republished.expiresAt > firstExpiresAt, true);
  });

  await t.test("a command whose cwd does not exist fails alone, not the server", async () => {
    resetPreviewCache();
    const preview = await createPreview({
      port: 46213,
      command: "node -e \"process.exit(0)\"",
      cwd: path.join(scratch, "a-directory-that-is-not-there"),
    });
    // The spawn fails on the missing `cwd` and emits `error`. Without a listener
    // that event is an uncaught exception, so *this test process dying* is what a
    // regression looks like; reaching the assertions is the proof it did not. Give
    // the async error a turn to land, then a preview that never started reads as
    // not running rather than as an outage.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(preview.pid, null);
    assert.equal(previewPublic(preview).running, false);
    await removePreview("p46213");
  });
});

test("a restart resumes the addresses whose processes did not survive", async (t) => {
  const serve =
    "node -e \"require('net').createServer().listen(Number(process.env.PORT), '127.0.0.1')\"";

  await t.test("a published address comes back serving", async (t) => {
    // The command holds a port, so it has to be reaped even if an assertion above
    // throws: a listener left behind keeps the port for every later run.
    t.after(async () => {
      await removePreview("p46215");
      assert.equal(await waitFree(46215), true);
    });
    await writeRegistryFile([registryRow("p46215", 46215, serve)]);
    assert.equal(await portIsFree(46215), true);
    assert.equal(await resumePreviews(), 1);
    assert.equal(await waitListening(46215), true);
  });

  await t.test("an address an operator stopped is left stopped", async () => {
    // A stop keeps the record so the name and the port stay reserved, so the
    // record alone cannot say why it is down. Resuming it here would start a
    // development server on the next deploy that somebody had turned off.
    await writeRegistryFile([{ ...registryRow("p46216", 46216, serve), stopped: true }]);
    assert.equal(await resumePreviews(), 0);
    assert.equal(await portIsFree(46216), true);
    await removePreview("p46216");
  });

  await t.test("an address with no command is not started", async () => {
    // Registered by hand, or served by something this process never started:
    // there is nothing here that could run it, so it is not a failure either.
    await writeRegistryFile([registryRow("p46217", 46217, "")]);
    assert.equal(await resumePreviews(), 0);
    await removePreview("p46217");
  });

  await t.test("an expired address is left to the sweep", async () => {
    await writeRegistryFile([
      { ...registryRow("p46218", 46218, serve), expiresAt: Date.now() - 1_000 },
    ]);
    assert.equal(await resumePreviews(), 0);
    assert.equal(await portIsFree(46218), true);
    await removePreview("p46218");
  });

  await t.test("a second process is never put on a bound port", async (t) => {
    const upstream = await startUpstream("occupied");
    t.after(async () => {
      await upstream.close();
    });
    // The record says the address is Genie's, but the port says something else is
    // answering on it. The port is what the person opening the link sees, so it
    // decides — and the running server is left where it is.
    await writeRegistryFile([registryRow(`p${upstream.port}`, upstream.port, serve)]);
    assert.equal(await resumePreviews(), 0);
    assert.equal(await portIsFree(upstream.port), false);
    await removePreview(`p${upstream.port}`);
  });
});

test("a custom name is refused while Magnate is not configured", async () => {
  await assert.rejects(() => magnateEntitled("someone@example.test"), /MAGNATE_ENTITLEMENTS_URL/);
});

test("the same port can be reached at its address", async (t) => {
  const upstream = await startUpstream("preview-answer");
  resetPreviewCache();
  await createPreview({ port: upstream.port, command: undefined });

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  await t.test("the wildcard Host is proxied to the port", async () => {
    const reply = await getWithHost(port, `p${upstream.port}.${PREVIEW_DOMAIN}`);
    assert.equal(reply.status, 200);
    assert.equal(reply.body, "preview-answer");
  });

  await t.test("an unregistered preview address is a 404, not the console", async () => {
    const reply = await getWithHost(port, `p46239.${PREVIEW_DOMAIN}`);
    assert.equal(reply.status, 404);
    assert.match(reply.body, /no preview/);
  });

  await t.test("the console's own Host still reaches the console", async () => {
    const reply = await getWithHost(port, "genie.innotel.us", "/health");
    assert.equal(reply.status, 200);
    assert.match(reply.body, /ontrak-genie/);
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await upstream.close();
  await removePreview(`p${upstream.port}`);
});

test("a bare proxy reports a backend that is not answering yet", async () => {
  const server = http.createServer((req, res) => {
    proxyPreview(req, res, {
      name: "p46238",
      port: 46238,
      host: "127.0.0.1",
      cwd: "",
      account: "",
      custom: false,
      command: "",
      pid: null,
      stopped: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: 0,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const reply = await getWithHost(port, "ignored", "/");
  assert.equal(reply.status, 502);
  assert.match(reply.body, /not answering yet/);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("the API lists what is registered", async (t) => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  await t.test("the empty list names the wildcard", async () => {
    const response = await fetch(`${base}/api/previews`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { enabled: boolean; domain: string };
    assert.equal(payload.enabled, true);
    assert.equal(payload.domain, PREVIEW_DOMAIN);
  });

  await t.test("a created preview is listed and then deleted", async () => {
    const created = await fetch(`${base}/api/previews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 46220 }),
    });
    assert.equal(created.status, 201);
    const { preview } = (await created.json()) as { preview: { name: string; url: string } };
    assert.equal(preview.name, "p46220");
    assert.equal(preview.url, `https://p46220.${PREVIEW_DOMAIN}`);

    const listed = (await (await fetch(`${base}/api/previews`)).json()) as {
      previews: Array<{ name: string }>;
    };
    assert.equal(listed.previews.some((row) => row.name === "p46220"), true);

    const deleted = await fetch(`${base}/api/previews/p46220`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("the whole registry is what listPreviews returns", async () => {
  resetPreviewCache();
  await createPreview({ port: 46230 });
  const rows = await listPreviews();
  assert.equal(rows.some((row) => row.name === "p46230"), true);
  await removePreview("p46230");
});
