import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * A service acting for a person: `actorSession`.
 *
 * The whole feature is a trust decision, so what is pinned here is every way it must
 * *not* fire — no shared bearer, a wrong bearer, no address, an address that is not
 * an address, an account the plane does not have, an account with no subject — and
 * the two ways it must: the real subject comes back, and a plane that cannot answer
 * is an outage rather than a silent "nobody".
 *
 * The disabled case lives in `actor-disabled.test.ts`, because `config.ts` reads the
 * environment once per process — the same split the entitlement tests use.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "actor-test-"));
process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");

let asked: string[] = [];
/** What the plane answers next: a status and a body. */
let answer: { status: number; body: unknown } = { status: 200, body: { sub: "authentik-sub-1", email: "operator@innotel.us" } };

const plane = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  asked.push(`${url.pathname}${url.search}`);
  res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
});
await new Promise<void>((resolve) => plane.listen(0, "127.0.0.1", resolve));

process.env.CONTROL_PLANE_INTERNAL_URL = `http://127.0.0.1:${(plane.address() as AddressInfo).port}`;
process.env.CONTROL_INTERNAL_TOKEN = "plane-token-for-tests";
process.env.WEB_TOKEN = "shared-bearer-for-tests";
process.env.TRUSTED_ACTOR_HEADER = "1";

const { actorSession } = await import("../actor.js");
const { ControlPlaneError } = await import("../controlplane.js");

test.after(() => {
  plane.close();
});

test.beforeEach(() => {
  asked = [];
  answer = { status: 200, body: { sub: "authentik-sub-1", email: "operator@innotel.us" } };
});

/** A request as node hands it to a handler — only the two things this module reads. */
function request(headers: Record<string, string>): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage;
}

const bearer = { authorization: "Bearer shared-bearer-for-tests" };

test("the shared bearer plus an address resolves to the account's own subject", async () => {
  const session = await actorSession(request({ ...bearer, "x-genie-actor": "operator@innotel.us" }));
  assert.ok(session);
  assert.equal(session.sub, "authentik-sub-1");
  assert.equal(session.email, "operator@innotel.us");
  assert.ok(session.exp > Math.floor(Date.now() / 1000), "the session outlives the request");
  assert.equal(asked.length, 1);
  assert.match(String(asked[0]), /^\/api\/internal\/identity\/resolve\?email=operator%40innotel\.us$/);
});

test("the address is read case-insensitively, as a proxy hands it over", async () => {
  const session = await actorSession(request({ ...bearer, "x-genie-actor": "  Operator@InnoTel.US \n" }));
  assert.ok(session);
  assert.equal(session?.email, "operator@innotel.us");
});

test("the shared bearer alone is not an identity", async () => {
  assert.equal(await actorSession(request({ ...bearer })), null);
  assert.equal(asked.length, 0, "nothing to resolve means nothing is asked");
});

test("an actor header without the shared bearer is ignored", async () => {
  assert.equal(await actorSession(request({ "x-genie-actor": "operator@innotel.us" })), null);
  assert.equal(await actorSession(request({ authorization: "Bearer not-the-bearer", "x-genie-actor": "operator@innotel.us" })), null);
  assert.equal(asked.length, 0);
});

test("something that is not an address never reaches the plane", async () => {
  for (const value of ["", "   ", "operator", "operator@localhost", "@innotel.us"]) {
    assert.equal(await actorSession(request({ ...bearer, "x-genie-actor": value })), null);
  }
  assert.equal(asked.length, 0, "a malformed address is answered here, not upstream");
});

test("an address the plane does not know is nobody, not an error", async () => {
  answer = { status: 404, body: { error: "user_not_found" } };
  assert.equal(await actorSession(request({ ...bearer, "x-genie-actor": "stranger@innotel.us" })), null);
});

test("an account with no subject to act for is nobody either", async () => {
  answer = { status: 409, body: { error: "no_oidc_subject" } };
  assert.equal(await actorSession(request({ ...bearer, "x-genie-actor": "password-only@innotel.us" })), null);
});

test("a plane that is down is an outage, not an unauthenticated caller", async () => {
  // The plane is passed in rather than reached through `config`, which is read once
  // and read-only: a closed port (9) refuses instead of hanging, so this asserts the
  // branch rather than a timeout.
  await assert.rejects(
    actorSession(request({ ...bearer, "x-genie-actor": "operator@innotel.us" }), { url: "http://127.0.0.1:9", token: "t" }),
    (error: unknown) => {
      assert.equal(error instanceof ControlPlaneError, true);
      assert.match((error as Error).message, /could not resolve who operator@innotel\.us is/);
      return true;
    },
  );
});

test("a refusal that is not about the person is an outage too", async () => {
  answer = { status: 500, body: { error: "boom" } };
  await assert.rejects(
    actorSession(request({ ...bearer, "x-genie-actor": "operator@innotel.us" })),
    (error: unknown) => error instanceof ControlPlaneError,
  );
});

test("an answer with no subject is not read as one", async () => {
  answer = { status: 200, body: { email: "operator@innotel.us" } };
  assert.equal(await actorSession(request({ ...bearer, "x-genie-actor": "operator@innotel.us" })), null);
  answer = { status: 200, body: { sub: "   " } };
  assert.equal(await actorSession(request({ ...bearer, "x-genie-actor": "operator@innotel.us" })), null);
});
