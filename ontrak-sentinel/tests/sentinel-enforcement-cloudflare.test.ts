/**
 * OnTrak Sentinel 2.1 tests: the **vendor** enforcement adapter, driven end to end.
 *
 * 2.0 shipped the seam (`EnforcementTarget`) and a JSON `POST` an operator wrote against
 * their own firewall. 2.1 ships the first real vendor — Cloudflare IP Access Rules — and
 * this file holds it to the claims that make a vendor adapter safe to ship:
 *
 *  - **What was decided is what is posted.** One block per address, the action's own id in
 *    the note, the bearer token on the request — and nothing at all when the action names an
 *    identity or a device, because an access rule cannot express one. A refusal that names
 *    the target is better than half an action that reads as applied.
 *  - **A lift finds what a block wrote.** The rule id is remembered, and a process that
 *    restarted asks Cloudflare by the note written at block time. A TTL that could not be
 *    undone after a restart would be a promise made on paper.
 *  - **The vendor's refusal is an outcome.** A 403 keeps the vendor's own sentence and
 *    leaves the action `ACTIVE` with `enforcement.plane.failed` on the chain — the same
 *    answer an unreachable generic plane gives. Nothing here may take an approval down.
 *  - **The exit is real:** telemetry → detection → an approved block → a Cloudflare call,
 *    in one test, against a stub that speaks the vendor's API rather than a mocked `fetch`.
 *
 * The stub is a local HTTP server on loopback: the adapter is pointed at it with
 * `apiBase`, so the wire format is exercised without a Cloudflare account or a network.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import type { AuditEvent } from "../src/lib/audit-chain";
import { sha256Hex } from "../src/lib/hash";
import { sampleBatches } from "../src/lib/detection-samples";
import { DetectionService, MemoryAlertStore } from "../src/lib/detection-service";
import { planeFromEnv } from "../src/lib/enforcement-plane";
import {
  DEFAULT_ENFORCEMENT_POLICY,
  type RollbackPlan,
} from "../src/lib/enforcement-rules";
import {
  EnforcementService,
  MemoryEnforcementStore,
  type EnforcementActionRecord,
} from "../src/lib/enforcement-service";
import { CloudflareEnforcementPlane } from "../src/lib/enforcement-vendor-cloudflare";
import { GuardService } from "../src/lib/guard-service";
import {
  IdentityService,
  MemoryIdentityStore,
  OrganizationAuditLog,
} from "../src/lib/identity-service";

const NOW = "2026-11-01T08:00:00.000Z";
const COLLECTION = "/accounts/acct-test/firewall/access_rules/rules";

/* -------------------------------------------------------------------------- */
/*  The vendor, stubbed on loopback                                           */
/* -------------------------------------------------------------------------- */

interface StubCall {
  method: string;
  path: string;
  query: string;
  authorization: string;
  body: Record<string, unknown> | null;
}

/**
 * A stand-in for Cloudflare's access-rules API.
 *
 * It implements exactly the four things the adapter uses — create, list by note, delete,
 * and a refusal — and it refuses a request that does not carry the token. That last part is
 * what makes the header assertion meaningful: the adapter is not merely sending something,
 * it is being believed by a server that checks it.
 */
class CloudflareStub {
  readonly calls: StubCall[] = [];
  base = "";
  private server: http.Server | null = null;
  private readonly rules = new Map<string, { id: string; notes: string; value: string }>();
  private seq = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("the stub has no port");
    this.base = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (this.server === null) return;
    const server = this.server;
    this.server = null;
    // Node's fetch keeps connections alive, and a close that waited on an idle one would
    // hang the suite rather than fail it.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://stub");
    const text = await readBody(req);
    const parsed = text === "" ? null : (JSON.parse(text) as Record<string, unknown>);
    this.calls.push({
      method: req.method ?? "",
      path: url.pathname,
      query: url.search,
      authorization: String(req.headers.authorization ?? ""),
      body: parsed,
    });

    if (String(req.headers.authorization ?? "") !== "Bearer cf-token") {
      send(res, 401, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
      return;
    }

    if (url.pathname === COLLECTION && req.method === "POST") {
      const configuration = (parsed?.configuration ?? undefined) as
        | { target?: string; value?: string }
        | undefined;
      const notes = typeof parsed?.notes === "string" ? parsed.notes : "";
      const value = configuration?.value ?? "";
      // One address the vendor is told to refuse, so the adapter's refusal path is driven
      // through a real 403 rather than a hand-built outcome.
      if (value === "198.51.100.66") {
        send(res, 403, {
          success: false,
          errors: [{ code: 1001, message: "target is on our own protected list" }],
        });
        return;
      }
      const id = `rule_${++this.seq}`;
      this.rules.set(id, { id, notes, value });
      send(res, 200, {
        success: true,
        result: { id, notes, configuration },
      });
      return;
    }

    if (url.pathname === COLLECTION && req.method === "GET") {
      const notes = url.searchParams.get("notes") ?? "";
      const result = [...this.rules.values()]
        .filter((rule) => rule.notes === notes)
        .map((rule) => ({
          id: rule.id,
          notes: rule.notes,
          configuration: { target: "ip", value: rule.value },
        }));
      send(res, 200, { success: true, result });
      return;
    }

    if (url.pathname.startsWith(`${COLLECTION}/`) && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.slice(COLLECTION.length + 1));
      if (!this.rules.has(id)) {
        send(res, 404, { success: false, errors: [{ code: 1002, message: "rule not found" }] });
        return;
      }
      this.rules.delete(id);
      send(res, 200, { success: true, result: { id } });
      return;
    }

    send(res, 404, { success: false, errors: [{ message: "no such endpoint" }] });
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Start the stub, run the body, and always close the socket. */
async function withStub(run: (stub: CloudflareStub) => Promise<void>): Promise<void> {
  const stub = new CloudflareStub();
  await stub.start();
  try {
    await run(stub);
  } finally {
    await stub.stop();
  }
}

function planeFor(stub: CloudflareStub): CloudflareEnforcementPlane {
  return new CloudflareEnforcementPlane({
    token: "cf-token",
    accountId: "acct-test",
    apiBase: stub.base,
  });
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

function record(overrides: Partial<EnforcementActionRecord> = {}): EnforcementActionRecord {
  return {
    id: "act_1",
    organizationId: "org_1",
    action: "BLOCK",
    state: "ACTIVE",
    targets: [{ kind: "ADDRESS", value: "203.0.113.9", label: "the C2 host" }],
    alertId: "alert_1",
    reason: "Beaconing to a known C2 address every 30 seconds.",
    requestedById: "admin_1",
    requestedByLabel: "Ana",
    requestedByRole: "ADMIN",
    approvedById: "admin_2",
    approvedByLabel: "Bea",
    appliedAt: NOW,
    expiresAt: null,
    detectedAt: NOW,
    timeToPreventMs: 0,
    liftedAt: null,
    liftedById: null,
    liftedByLabel: null,
    liftReason: null,
    refusedCode: null,
    refusedReason: null,
    rollback: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function liftPlan(overrides: Partial<RollbackPlan> = {}): RollbackPlan {
  return {
    kind: "LIFT",
    action: "BLOCK",
    targets: [{ kind: "ADDRESS", value: "203.0.113.9", label: "the C2 host" }],
    at: null,
    label: "lift this block by hand",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  What a block writes                                                       */
/* -------------------------------------------------------------------------- */

test("cloudflare: a block posts one access rule per address, with the decision's id in the note", async () => {
  await withStub(async (stub) => {
    const plane = planeFor(stub);
    assert.equal(plane.name, "cloudflare:acct-test", "the name carries the account, never the token");

    const outcome = await plane.apply(record());
    assert.deepEqual(outcome, {
      ok: true,
      detail: "blocked 1 address(es) with Cloudflare access rules (cloudflare:acct-test)",
    });

    const posts = stub.calls.filter((call) => call.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.path, COLLECTION);
    assert.equal(posts[0]?.authorization, "Bearer cf-token");
    // The whole body is asserted, because each field is a decision: an access rule, the note
    // that joins Cloudflare's log to this action, and an address rather than a range.
    assert.deepEqual(posts[0]?.body, {
      mode: "block",
      notes: "sentinel:act_1",
      configuration: { target: "ip", value: "203.0.113.9" },
    });
  });
});

test("cloudflare: a CIDR is sent as a range, because an access rule has two address shapes", async () => {
  await withStub(async (stub) => {
    const plane = planeFor(stub);
    const outcome = await plane.apply(
      record({ targets: [{ kind: "ADDRESS", value: "203.0.113.0/24" }] }),
    );
    assert.equal(outcome.ok, true);
    const sent = stub.calls[0]?.body as
      | { configuration?: { target?: string } }
      | undefined;
    assert.equal(sent?.configuration?.target, "ip_range");
  });
});

/* -------------------------------------------------------------------------- */
/*  What a lift removes                                                       */
/* -------------------------------------------------------------------------- */

test("cloudflare: a lift deletes the rule the block created", async () => {
  await withStub(async (stub) => {
    const plane = planeFor(stub);
    assert.equal((await plane.apply(record())).ok, true);

    const outcome = await plane.lift(record(), liftPlan());
    assert.deepEqual(outcome, {
      ok: true,
      detail: "lifted 1 Cloudflare access rule(s) (cloudflare:acct-test)",
    });

    const deletes = stub.calls.filter((call) => call.method === "DELETE");
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0]?.path, `${COLLECTION}/rule_1`);
    assert.equal(deletes[0]?.authorization, "Bearer cf-token");
  });
});

test("cloudflare: a restart loses the rule cache, not the ability to lift", async () => {
  await withStub(async (stub) => {
    // The process that blocked it is gone; a new one was constructed against the same
    // account, so it has no remembered id.
    assert.equal((await planeFor(stub).apply(record())).ok, true);

    const outcome = await planeFor(stub).lift(record(), liftPlan());
    assert.equal(outcome.ok, true);

    const lookups = stub.calls.filter((call) => call.method === "GET");
    assert.equal(lookups.length, 1);
    assert.match(lookups[0]?.query ?? "", /notes=sentinel%3Aact_1/);
    const deletes = stub.calls.filter((call) => call.method === "DELETE");
    assert.equal(deletes.length, 1, "the rule was found by its note and removed");
    assert.equal(deletes[0]?.path, `${COLLECTION}/rule_1`);
  });
});

test("cloudflare: a lift with nothing to remove answers ok, so a sweep is idempotent", async () => {
  await withStub(async (stub) => {
    const outcome = await planeFor(stub).lift(record(), liftPlan());
    assert.deepEqual(outcome, {
      ok: true,
      detail: "Cloudflare had no rule left to lift for this action",
    });
    assert.equal(stub.calls.filter((call) => call.method === "DELETE").length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/*  What the vendor cannot express                                            */
/* -------------------------------------------------------------------------- */

test("cloudflare: an identity or a device is refused before anything is dialled", async () => {
  await withStub(async (stub) => {
    const outcome = await planeFor(stub).apply(
      record({ targets: [{ kind: "IDENTITY", value: "user-1", label: "the account" }] }),
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.error, /IDENTITY “user-1”/);
      assert.match(outcome.error, /Nothing was sent/);
    }
    assert.equal(stub.calls.length, 0, "a target the vendor cannot express must not become a partial block");
  });
});

test("cloudflare: a vendor refusal is an outcome, and its own words are kept", async () => {
  await withStub(async (stub) => {
    const outcome = await planeFor(stub).apply(
      record({ targets: [{ kind: "ADDRESS", value: "198.51.100.66" }] }),
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.error, /target is on our own protected list/);
    // Nothing was remembered, so a later lift asks the vendor rather than deleting a rule
    // that does not exist.
    assert.equal((await planeFor(stub).lift(record(), liftPlan({ targets: [{ kind: "ADDRESS", value: "198.51.100.66" }] }))).ok, true);
    assert.equal(stub.calls.filter((call) => call.method === "DELETE").length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/*  The exit: detection → block → a vendor call                               */
/* -------------------------------------------------------------------------- */

test("cloudflare: a detection becomes a block, and the block reaches the vendor", async () => {
  await withStub(async (stub) => {
    const audit = new OrganizationAuditLog(sha256Hex);
    const entities = new MemoryIdentityStore();
    let spineSeq = 0;
    const spine = new IdentityService(entities, audit, {
      id: () => `cf-id-${++spineSeq}`,
      now: () => NOW,
      nowMs: () => Date.parse(NOW),
    });
    const created = await spine.bootstrapOrganization(
      "test",
      { name: "Acme Inc", slug: "acme" },
      { identifier: "admin@acme.test", displayName: "Admin" },
    );
    if (!created.ok) assert.fail(created.error);

    const store = new MemoryEnforcementStore();
    let enforcementSeq = 0;
    const enforcement = new EnforcementService(
      store,
      audit,
      { id: () => `en-${++enforcementSeq}`, now: () => NOW },
      planeFor(stub),
    );
    const detection = new DetectionService(
      new MemoryAlertStore(),
      entities,
      audit,
      undefined,
      undefined,
      sha256Hex,
    );
    const guard = new GuardService(
      detection,
      entities,
      { token: "ingest-token", organizationSlug: null },
      enforcement,
    );

    const policy = await enforcement.setPolicy(
      created.value.organization.id,
      { ...DEFAULT_ENFORCEMENT_POLICY, requireSecondApprover: false, maxTargets: 5 },
      { identityId: created.value.admin.id, label: "Admin" },
    );
    if (!policy.ok) assert.fail(policy.error);

    // A real sample batch through the real ingest surface: the port scan, which arrives as
    // NETFLOW events and raises SG-BEH-001.
    const batch = sampleBatches(Date.parse(NOW)).find((entry) => entry.expect.includes("SG-BEH-001"));
    assert.ok(batch, "the shipped corpus still has the port-scan sample");
    const ingested = await guard.ingest({
      authorization: "Bearer ingest-token",
      organization: "acme",
      payload: { source: batch.source, sensor: batch.sensor, events: batch.events },
      at: Date.parse(NOW),
    });
    if (!ingested.ok) assert.fail(ingested.error);
    const alert = ingested.value.alerts.find((entry) => entry.ruleId === "SG-BEH-001");
    assert.ok(alert, "the port-scan sample raises SG-BEH-001");

    const applied = await enforcement.apply({
      organizationId: created.value.organization.id,
      proposal: {
        action: "BLOCK",
        targets: [{ kind: "ADDRESS", value: "203.0.113.50", label: "the scanning host" }],
        alertId: alert.id,
        reason: "Twenty-five lateral SMB connections from one source in a minute.",
        requestedBy: { identityId: created.value.admin.id, label: "Admin", role: "ADMIN" },
      },
      detectedAt: NOW,
    });
    if (!applied.ok) assert.fail(applied.error);
    assert.equal(applied.value.action.state, "ACTIVE");

    // The exit, stated as the three calls that make it true: the detection is recorded, the
    // decision is in force, and Cloudflare was told — with the action's id in the note so the
    // vendor's own log joins back to the evidence chain.
    const posts = stub.calls.filter((call) => call.method === "POST");
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0]?.body, {
      mode: "block",
      notes: `sentinel:${applied.value.action.id}`,
      configuration: { target: "ip", value: "203.0.113.50" },
    });

    const told = audit
      .trail(created.value.organization.id)
      .find((entry: AuditEvent) => entry.action === "enforcement.plane.apply");
    assert.ok(told, "the evidence chain says the plane was told");
    const detail = told.detail as Record<string, unknown>;
    assert.equal(detail.plane, "cloudflare:acct-test");
    assert.equal(detail.op, "apply");

    const lifted = await enforcement.lift({
      organizationId: created.value.organization.id,
      actionId: applied.value.action.id,
      by: { identityId: created.value.admin.id, label: "Admin" },
      reason: "the host was rebuilt",
    });
    if (!lifted.ok) assert.fail(lifted.error);
    const deletes = stub.calls.filter((call) => call.method === "DELETE");
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0]?.path, `${COLLECTION}/rule_1`);
    assert.ok(
      audit
        .trail(created.value.organization.id)
        .some((entry: AuditEvent) => entry.action === "enforcement.plane.lift"),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  The environment                                                           */
/* -------------------------------------------------------------------------- */

test("cloudflare: the vendor is named in the environment, and an incomplete one says why", async () => {
  assert.equal(planeFromEnv({}), null, "nothing named is still no plane");

  const named = planeFromEnv({
    SENTINEL_ENFORCEMENT_VENDOR: "cloudflare",
    CLOUDFLARE_API_TOKEN: "cf-token",
    CLOUDFLARE_ACCOUNT_ID: "acct-test",
  });
  assert.ok(named !== null);
  assert.ok(named instanceof CloudflareEnforcementPlane);
  assert.equal(named.name, "cloudflare:acct-test");

  // A named vendor that is missing a variable is a plane that refuses, not a deployment
  // that silently has none: an operator must be able to tell the two apart from the chain.
  const incomplete = planeFromEnv({
    SENTINEL_ENFORCEMENT_VENDOR: "cloudflare",
    CLOUDFLARE_API_TOKEN: "cf-token",
  });
  assert.ok(incomplete !== null);
  const refused = await incomplete.apply(record());
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /CLOUDFLARE_ACCOUNT_ID is unset/);

  const unknown = planeFromEnv({ SENTINEL_ENFORCEMENT_VENDOR: "paloalto" });
  assert.ok(unknown !== null);
  const unsupported = await unknown.apply(record());
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.match(unsupported.error, /not a vendor this build ships/);

  // The vendor outranks the generic URL — two answers to the same question, and the vendor
  // is the more specific one.
  const both = planeFromEnv({
    SENTINEL_ENFORCEMENT_VENDOR: "cloudflare",
    CLOUDFLARE_API_TOKEN: "cf-token",
    CLOUDFLARE_ACCOUNT_ID: "acct-test",
    SENTINEL_ENFORCEMENT_PLANE_URL: "http://127.0.0.1:9/enforce",
  });
  assert.ok(both instanceof CloudflareEnforcementPlane);
});
