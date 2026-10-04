import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * The console as a *client* of the preview hosting server.
 *
 * When previews run in their own container, this process no longer starts a dev
 * server or routes the wildcard — it asks the hosting server to. What the tests
 * here pin down is the contract across that hop: the console does not answer for
 * a hosting server it cannot reach, it carries the bearer, it sends the identity a
 * custom name is checked against, and it reports the host's own refusals instead of
 * inventing a preview.
 */

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "preview-remote-"));
process.env.AGENT_WORKSPACE = scratch;
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");
// The console does NOT host here: it delegates. `previewEnabled()` stays false so
// it never tries to route the wildcard itself.
process.env.PREVIEW_ENABLED = "false";
process.env.PREVIEW_DOMAIN = "genie.innotel.us";
process.env.PREVIEW_BACKEND_HOST = "127.0.0.1";

/** What the fake hosting server saw, and what it should answer with. */
interface Call {
  method: string;
  url: string;
  authorization: string;
  body: unknown;
}

let calls: Call[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    let body: unknown = null;
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    calls.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: String(req.headers.authorization ?? ""),
      body,
    });
    res.writeHead(answer.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const hostingPort = (upstream.address() as AddressInfo).port;

process.env.GENIE_HOSTING_URL = `http://127.0.0.1:${hostingPort}/`;
process.env.GENIE_HOSTING_TOKEN = "hosting-secret";

const {
  createPreview,
  getPreview,
  hostingEnabled,
  listPreviews,
  previewEnabled,
  removePreview,
  stopPreview,
  PreviewError,
} = await import("../preview-hosting.js");

function reset(next: { status: number; body: unknown }): void {
  calls = [];
  answer = next;
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "p4001",
    host: "p4001.genie.innotel.us",
    url: "https://p4001.genie.innotel.us",
    port: 4001,
    custom: false,
    command: "npm run dev",
    running: true,
    createdAt: "2026-10-04T00:00:00.000Z",
    expiresAt: 0,
    ...overrides,
  };
}

test("the console is a hosting client, not a hosting server", async (t) => {
  await t.test("hosting is enabled when delegated, even though routing is not", () => {
    assert.equal(hostingEnabled(), true);
    assert.equal(previewEnabled(), false);
  });

  await t.test("listing previews reads the hosting server and maps its rows", async () => {
    reset({ status: 200, body: { previews: [row({ name: "acme", custom: true })] } });
    const previews = await listPreviews();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[0]?.url, "/api/previews");
    assert.equal(calls[0]?.authorization, "Bearer hosting-secret");
    assert.equal(previews.length, 1);
    assert.equal(previews[0]?.name, "acme");
    assert.equal(previews[0]?.port, 4001);
    assert.equal(previews[0]?.custom, true);
    // `running` survives the hop rather than being recomputed from a local pid.
    assert.equal(previews[0]?.running, true);
  });

  await t.test("creating sends the identity a custom name is checked against", async () => {
    reset({ status: 201, body: { preview: row({ name: "acme", custom: true }) } });
    const created = await createPreview({
      name: "acme",
      command: "npm run dev",
      cwd: "/workspace/project",
      account: "user-1",
      user: "buyer@example.com",
    });
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.url, "/api/previews");
    assert.deepEqual(calls[0]?.body, {
      name: "acme",
      command: "npm run dev",
      cwd: "/workspace/project",
      account: "user-1",
      user: "buyer@example.com",
    });
    assert.equal(created.name, "acme");
  });

  await t.test("a refusal from the hosting server is surfaced, not swallowed", async () => {
    reset({ status: 400, body: { error: '"acme" is already registered (port 4001)' } });
    await assert.rejects(
      () => createPreview({ name: "acme", user: "buyer@example.com" }),
      (error: unknown) =>
        error instanceof PreviewError && /already registered/.test((error as Error).message),
    );
  });

  await t.test("an unreachable hosting server is an error, not an empty registry", async () => {
    // `config` is read once at import, so the unreachable address is reached by
    // pointing the imported config at a port nothing can be listening on.
    const { config } = await import("../config.js");
    const original = config.hostingUrl;
    (config as unknown as { hostingUrl: string }).hostingUrl = "http://127.0.0.1:9";
    try {
      await assert.rejects(
        () => listPreviews(),
        (error: unknown) =>
          error instanceof PreviewError && /unreachable/.test((error as Error).message),
      );
    } finally {
      (config as unknown as { hostingUrl: string }).hostingUrl = original;
    }
  });

  await t.test("a missing address is not found, and stopping/removing report the host's answer", async () => {
    reset({ status: 404, body: { error: "preview not found" } });
    assert.equal(await getPreview("nope"), null);

    reset({ status: 200, body: { stopped: true } });
    assert.equal(await stopPreview("p4001"), true);
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.url, "/api/previews/p4001/stop");

    reset({ status: 200, body: { removed: true } });
    assert.equal(await removePreview("p4001"), true);
    assert.equal(calls[0]?.method, "DELETE");
    assert.equal(calls[0]?.url, "/api/previews/p4001");
  });
});

test.after(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await fs.rm(scratch, { recursive: true, force: true });
});
