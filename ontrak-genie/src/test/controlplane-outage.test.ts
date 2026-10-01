import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, beforeEach } from "node:test";

import {
  noteControlPlaneOutage,
  pendingControlPlaneOutage,
  reportControlPlaneOutage,
  resetControlPlaneOutage,
  type ControlPlaneConfig,
} from "../controlplane.js";
import type { Session } from "../oidc.js";
import { beginTurn, resetCallerCache } from "../tenancy.js";

/**
 * Reporting a tenancy outage (M8).
 *
 * The failure this covers is invisible by construction: Genie finds out the
 * control plane is unreachable *because* it could not reach it, so at the moment
 * it happens there is nowhere to send word. It is recorded, and reported on the
 * next call that succeeds — which is the only thing that makes a refused turn
 * leave a trace an operator can find. These cases pin the window (one alert for
 * many failures), the delivery, and the wiring that calls it.
 *
 * The plane is a stand-in HTTP server that answers by path, so there is no queue
 * to race: the report is fire-and-forget after a successful call, and asserting
 * on arrival order would be testing the scheduler rather than the behaviour.
 */

let mode: "up" | "down" = "up";
const calls: { path: string; method: string; internalToken: string | undefined; body: any }[] = [];

const plane = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    calls.push({
      path: req.url ?? "",
      method: req.method ?? "",
      internalToken: req.headers["x-control-internal-token"] as string | undefined,
      body: raw === "" ? null : JSON.parse(raw),
    });

    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (mode === "down") return send(503, { error: "service unavailable" });
    if (req.url === "/api/internal/identity") {
      return send(200, {
        user: { id: "user-1", email: "a@example.test" },
        gatewayKey: "sk-account",
        quota: { plan: "free" },
      });
    }
    if (req.url === "/api/internal/quota-check") return send(200, { allowed: true, reasons: [] });
    if (req.url === "/api/internal/alert") return send(202, { ok: true, sent: true });
    return send(404, { error: "not found" });
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

beforeEach(() => {
  mode = "up";
  calls.length = 0;
  resetControlPlaneOutage();
  resetCallerCache();
});

const session: Session = {
  sub: "sub-1",
  email: "a@example.test",
  name: "A",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const alertCalls = () => calls.filter((call) => call.path === "/api/internal/alert");

test("repeated failures become one window, not one window each", () => {
  noteControlPlaneOutage("first: connect ECONNREFUSED", 1_000);
  noteControlPlaneOutage("second: socket hang up", 5_000);

  const pending = pendingControlPlaneOutage();
  assert.ok(pending, "an outage is recorded");
  assert.equal(pending.failedCalls, 2, "two failures, one window");
  assert.equal(pending.since, 1_000);
  assert.equal(pending.until, 5_000);
  assert.equal(pending.detail, "second: socket hang up", "the latest failure describes the window");
});

test("a recorded outage is delivered with the service token and then cleared", async () => {
  noteControlPlaneOutage("connect ECONNREFUSED");
  await reportControlPlaneOutage(planeConfig);

  const sent = alertCalls();
  assert.equal(sent.length, 1, "the outage was reported once");
  const report = sent[0]!;
  assert.equal(report.method, "POST");
  assert.equal(report.internalToken, planeConfig.token, "it is a service call, not a user call");
  assert.equal(report.body.event, "controlplane.unreachable");
  assert.equal(report.body.meta.failedCalls, 1);
  assert.equal(pendingControlPlaneOutage(), null, "a delivered outage is forgotten");
});

test("a report the plane refuses keeps the window for the next attempt", async () => {
  mode = "down";
  noteControlPlaneOutage("still down");
  await reportControlPlaneOutage(planeConfig);

  assert.ok(pendingControlPlaneOutage(), "the record survives a failed report");
  assert.equal(pendingControlPlaneOutage()?.detail, "still down");
});

test("a refused turn records an outage, and the next success reports it", async () => {
  mode = "down";
  const refused = await beginTurn(session, planeConfig);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.status, 503);
  assert.equal(pendingControlPlaneOutage()?.failedCalls, 1, "the gate recorded what it could not report");

  mode = "up";
  resetCallerCache(); // the stand-in plane changing its answer is not a real cache hit
  const started = await beginTurn(session, planeConfig);
  assert.equal(started.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 50)); // the report is fire-and-forget

  const sent = alertCalls();
  assert.equal(sent.length, 1, "the recovered call reported the outage");
  assert.equal(sent[0]!.body.event, "controlplane.unreachable");
  assert.equal(pendingControlPlaneOutage(), null);
});

test("a 4xx is a verdict about the caller, not an outage", async () => {
  // A conflict (email bound to another subject) is the plane answering. Recording
  // it as an outage would page an operator for one person's account problem.
  const plane4xx = http.createServer((_req, res) => {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "already linked" }));
  });
  await new Promise<void>((resolve) => plane4xx.listen(0, "127.0.0.1", resolve));
  const config: ControlPlaneConfig = {
    url: `http://127.0.0.1:${(plane4xx.address() as AddressInfo).port}`,
    token: "internal-token",
  };
  try {
    const result = await beginTurn(session, config);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.status, 409, "the caller sees the plane's own answer");
    assert.equal(pendingControlPlaneOutage(), null, "a verdict is not an outage");
  } finally {
    plane4xx.close();
  }
});
