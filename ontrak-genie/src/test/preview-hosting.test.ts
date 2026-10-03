import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
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

const {
  allocatePort,
  createPreview,
  getPreview,
  isAutoPreviewName,
  listPreviews,
  magnateEntitled,
  normalizePreviewName,
  previewLabelFromHost,
  proxyPreview,
  removePreview,
  resetPreviewCache,
  stopPreview,
} = await import("../preview-hosting.js");
const { createServer } = await import("../server.js");

const PREVIEW_DOMAIN = "genie.innotel.us";

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
