import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";

import { auditBuild, type ControlPlaneConfig } from "../controlplane.js";

/**
 * The `build.*` audit row Genie writes when an export leaves the system.
 *
 * The old build plane used to write these rows; Distro's admin panel still
 * reads them (`?action=build.`), so the contract that matters is the wire
 * shape: the action, the subject the plane resolves to an account, the target,
 * and the service token in the header.
 */

type Seen = { url?: string; method?: string; headers?: http.IncomingHttpHeaders; body?: any };

const seen: Seen = {};
const plane = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    seen.url = req.url;
    seen.method = req.method;
    seen.headers = req.headers;
    seen.body = raw ? JSON.parse(raw) : null;
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});

await new Promise<void>((resolve) => plane.listen(0, "127.0.0.1", resolve));
const planeConfig: ControlPlaneConfig = {
  url: `http://127.0.0.1:${(plane.address() as AddressInfo).port}`,
  token: "internal-token",
};

after(() => {
  plane.close();
});

test("an export records build.export against the signed-in subject", async () => {
  await auditBuild(planeConfig, {
    action: "build.export",
    sub: "sub-1",
    email: "dev@example.test",
    targetId: "p-1",
    meta: { project: "demo", files: 12, skipped: 0 },
  });

  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/api/internal/audit");
  assert.equal(seen.headers?.["x-control-internal-token"], "internal-token");
  assert.equal(seen.body.action, "build.export");
  assert.equal(seen.body.sub, "sub-1");
  assert.equal(seen.body.actorEmail, "dev@example.test");
  assert.equal(seen.body.targetId, "p-1");
  assert.equal(seen.body.meta.files, 12);
});

test("a refused audit does not throw: the export is already the caller's", async () => {
  const failing = http.createServer((req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "no" }));
  });
  await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
  const config: ControlPlaneConfig = {
    url: `http://127.0.0.1:${(failing.address() as AddressInfo).port}`,
    token: "t",
  };
  const original = console.error;
  console.error = () => {};
  try {
    await auditBuild(config, { action: "build.export", sub: "", targetId: "p-1" });
  } finally {
    console.error = original;
    failing.close();
  }
});
