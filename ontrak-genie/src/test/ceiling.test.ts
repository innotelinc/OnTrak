import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

/**
 * The ceiling Genie enforces on its own (v1.0).
 *
 * Distinct from the control plane's quota, and this file exists to hold that
 * distinction: the plane is the billing authority and the family runs on
 * unlimited usage, so its cap never refuses anyone. The bound on a runaway loop
 * is this one, and it is Genie's own number. So the cases below are about the
 * three things that make it a safety stop rather than a bill —
 *
 *   * the turn gate refuses at the limit, so nothing reaches the model past it;
 *   * the day is UTC and a new one resets the count with no timer and no state;
 *   * `0` means Genie enforces nothing, which is the shipped default.
 *
 * The limit is a configured value, so this file runs in its own process with a
 * deliberately small one; the `0` case is passed in explicitly.
 */

process.env.AGENT_ACCOUNT_CEILING_REQUESTS = "3";
process.env.CONTROL_PLANE_INTERNAL_URL = "";
process.env.CONTROL_INTERNAL_TOKEN = "";
process.env.OMNIROUTE_API_KEY = "";

const { ceilingFor, ceilingMessage, noteTurn, resetCeilings, utcDay } = await import("../ceiling.js");
const { beginTurn, resetCallerCache } = await import("../tenancy.js");
type ControlPlaneConfig = import("../controlplane.js").ControlPlaneConfig;
type Session = import("../oidc.js").Session;

const PLANE: ControlPlaneConfig = { url: "http://127.0.0.1:1", token: "plane-token" };

const session: Session = {
  sub: "sub-ceiling",
  email: "dev@innotel.us",
  name: "Dev",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

/* --------------------------------------------------------------- the plan - */

const plane = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        (req.url ?? "").includes("/identity")
          ? { userId: "u-ceiling", email: "dev@innotel.us", gatewayKey: "sk-tenant-ceiling" }
          : // The plan allows everything, which is the point: the family runs on
            // unlimited usage, so only Genie's own ceiling can refuse.
            { allowed: true, reasons: [] },
      ),
    );
  });
});

await new Promise<void>((resolve) => plane.listen(0, "127.0.0.1", resolve));
const PLANE_URL = `http://127.0.0.1:${(plane.address() as AddressInfo).port}`;
const LIVE: ControlPlaneConfig = { url: PLANE_URL, token: "plane-token" };

/* ------------------------------------------------------------------ rules - */

test("the ceiling rule", async (t) => {
  t.beforeEach(() => resetCeilings());

  await t.test("a limit of zero means Genie enforces nothing", () => {
    // The shipped default. It must read as "no ceiling" rather than as "no
    // turns left", which is the failure that makes an unconfigured deployment
    // refuse every request the moment it is tenanted.
    const ceiling = ceilingFor("u-1", Date.now(), 0);
    assert.equal(ceiling.allowed, true);
    assert.equal(ceiling.limit, 0);
    assert.equal(ceiling.remaining, null);

    // And a negative is treated the same way rather than as "already spent".
    assert.equal(ceilingFor("u-1", Date.now(), -5).allowed, true);
  });

  await t.test("the count rises with each turn and the allowance falls", () => {
    assert.deepEqual(ceilingFor("u-1"), { limit: 3, used: 0, remaining: 3, allowed: true });
    noteTurn("u-1");
    assert.deepEqual(ceilingFor("u-1"), { limit: 3, used: 1, remaining: 2, allowed: true });
    noteTurn("u-1");
    noteTurn("u-1");
    assert.deepEqual(ceilingFor("u-1"), { limit: 3, used: 3, remaining: 0, allowed: false });
  });

  await t.test("one account's turns are not another's", () => {
    noteTurn("u-1");
    noteTurn("u-1");
    noteTurn("u-2");
    assert.equal(ceilingFor("u-1").used, 2);
    assert.equal(ceilingFor("u-2").used, 1);
  });

  await t.test("the next UTC day resets the count, with nothing running at midnight", () => {
    const tonight = Date.parse("2026-09-30T23:59:00.000Z");
    const tomorrow = Date.parse("2026-10-01T00:01:00.000Z");
    noteTurn("u-1", tonight);
    noteTurn("u-1", tonight);
    assert.equal(ceilingFor("u-1", tonight).used, 2);

    // A count kept beside the day it belongs to is simply not found the next
    // day — which is why no timer is needed and a restart cannot leak one.
    assert.equal(utcDay(tomorrow), "2026-10-01");
    assert.equal(ceilingFor("u-1", tomorrow).used, 0);
    assert.equal(ceilingFor("u-1", tomorrow).allowed, true);
  });

  await t.test("the refusal names itself as a stop, not a charge", () => {
    const message = ceilingMessage(3, 3);
    assert.match(message, /ceiling is 3 per day/);
    assert.match(message, /runaway loop/);
    assert.match(message, /midnight UTC/);
  });
});

/* -------------------------------------------------------- the turn gate - */

test("the turn gate counts and refuses", async (t) => {
  t.beforeEach(() => {
    resetCeilings();
    resetCallerCache();
  });

  await t.test("a turn past the ceiling is refused, and the model is never reached", async () => {
    // Three allowed, the fourth refused. The gate is the only path to the
    // model, so "refused here" is "nothing was spent".
    for (let index = 0; index < 3; index += 1) {
      const started = await beginTurn(session, LIVE);
      assert.equal(started.ok, true, `turn ${index + 1} should be allowed`);
    }

    const refused = await beginTurn(session, LIVE);
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.status, 429);
      assert.match(refused.message, /ceiling is 3 per day/);
    }
  });

  await t.test("with no control plane there is no account, so nothing is counted", async () => {
    // Single-operator mode: no account to key on, and the ceiling is an
    // account's ceiling. It must not turn into a deployment-wide step budget.
    const started = await beginTurn(session, null);
    assert.equal(started.ok, true);
    if (started.ok) assert.equal(started.turn.caller, null);
  });

  await t.test("only a turn that was allowed is counted", async () => {
    // A refusal before the model (here, no sign-in) must not consume the
    // allowance — otherwise a misconfigured client could exhaust an account
    // without it ever getting an answer.
    const before = ceilingFor("u-ceiling").used;
    const started = await beginTurn({ ...session, sub: "" }, LIVE);
    assert.equal(started.ok, false);
    assert.equal(ceilingFor("u-ceiling").used, before);
  });
});

test.after(() => plane.close());
