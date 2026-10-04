import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * How long a published address lives.
 *
 * A free `p<port>` address is allocated from one bounded port range, so every
 * abandoned one is a port nobody else can publish on — it gets the *short* TTL.
 * A named address is what the plan sells, so it gets the long one, and it must
 * still be there after lunch. An explicit `ttlMs` from a caller always wins, and
 * `0` means "never" for an operator script that wants to pin either.
 *
 * Env is set before any module reads the config, and a stub Magnate answers the
 * entitlement call so the *custom* path — the one the paid TTL belongs to — can
 * be exercised without a real billing platform.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "preview-ttl-"));

const FREE_TTL_MS = 1_800_000;
const CUSTOM_TTL_MS = 3_600_000;

// Stub Magnate first, so its URL is known before the config is read.
const magnate = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ entitled: true }));
});
await new Promise<void>((resolve) => magnate.listen(0, "127.0.0.1", resolve));
const magnatePort = (magnate.address() as AddressInfo).port;

process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");
process.env.PREVIEW_ENABLED = "true";
process.env.PREVIEW_DOMAIN = "genie.innotel.us";
process.env.PREVIEW_BACKEND_HOST = "127.0.0.1";
process.env.PREVIEW_PORT_START = "46300";
process.env.PREVIEW_PORT_END = "46340";
process.env.PREVIEW_TTL_MS = String(CUSTOM_TTL_MS);
process.env.PREVIEW_FREE_TTL_MS = String(FREE_TTL_MS);
process.env.PREVIEW_SWEEP_INTERVAL_MS = "0";
process.env.MAGNATE_ENTITLEMENTS_URL = `http://127.0.0.1:${magnatePort}/api/entitlements`;
process.env.AGENT_SANDBOX = "host";

const { createPreview, previewPublic, removePreview, resetPreviewCache } = await import(
  "../preview-hosting.js"
);

/** Within a couple of seconds of `now + ttl`, which is all a wall clock allows. */
function near(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 5_000;
}

test("the TTL a published address gets", async (t) => {
  await t.test("a free `p<port>` address gets the short TTL", async () => {
    resetPreviewCache();
    const preview = await createPreview({ port: 46300 });
    const pub = previewPublic(preview);
    assert.equal(pub.custom, false);
    assert.equal(near(pub.expiresAt as number, Date.now() + FREE_TTL_MS), true);
    await removePreview("p46300");
  });

  await t.test("a named address gets the long TTL", async () => {
    resetPreviewCache();
    const preview = await createPreview({
      name: "acme",
      port: 46301,
      account: "acct",
      user: "someone@example.test",
    });
    const pub = previewPublic(preview);
    assert.equal(pub.custom, true);
    assert.equal(near(pub.expiresAt as number, Date.now() + CUSTOM_TTL_MS), true);
    await removePreview("acme");
  });

  await t.test("an explicit ttlMs overrides either default", async () => {
    resetPreviewCache();
    const preview = await createPreview({ port: 46302, ttlMs: 5_000 });
    assert.equal(near(preview.expiresAt, Date.now() + 5_000), true);
    await removePreview("p46302");
  });

  await t.test("ttlMs 0 means the address never expires", async () => {
    resetPreviewCache();
    const preview = await createPreview({ port: 46303, ttlMs: 0 });
    assert.equal(preview.expiresAt, 0);
    await removePreview("p46303");
  });

  await new Promise<void>((resolve) => magnate.close(() => resolve()));
});
