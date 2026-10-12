/**
 * OnTrak Sentinel S5 tests: prevention asked for by the desk.
 *
 * This is the direction where getting it wrong is expensive, so the tests are about the
 * *rails* rather than about a happy path:
 *
 *  - **Nothing reaches the wire that the rails would refuse.** A request reader that let a
 *    malformed target through would have `decideEnforcement` refuse it later with a worse
 *    sentence, and a caller that could name its own role could ask for anything.
 *  - **An unrecognised desk role is refused by name.** Defaulting an unknown role to `AGENT`
 *    would be this integration silently granting something; defaulting it to `ADMIN` would be
 *    worse. `null` is the answer, and the caller is told.
 *  - **The rails still decide.** A desk request is judged by the same safe-list, blast-radius
 *    cap and second-approver rule as a console proposal, and a refusal comes back as an
 *    *outcome* the desk records rather than as an error.
 *  - **The requester is namespaced.** `tix:<id>` can never equal a Sentinel identity, so the
 *    second-approver rail — a *different* administrator — holds by construction.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import {
  containmentRefusal,
  containmentReply,
  containmentStatus,
  describeContainment,
  mapDeskRole,
  readContainmentRequest,
} from "../src/lib/containment-rules";
import { DetectionService, MemoryAlertStore } from "../src/lib/detection-service";
import { DEFAULT_ENFORCEMENT_POLICY } from "../src/lib/enforcement-rules";
import { EnforcementService, MemoryEnforcementStore } from "../src/lib/enforcement-service";
import { GUARD_PATHS, routeGuard } from "../src/lib/guard-http";
import { GuardService } from "../src/lib/guard-service";
import { sha256Hex } from "../src/lib/hash";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog } from "../src/lib/identity-service";
import type { HttpRequest } from "../src/lib/oidc-http";

const sha256: HashFn = sha256Hex;
const AT = "2026-10-27T09:00:00.000Z";

/* -------------------------------------------------------------------------- */
/*  Reading a request                                                         */
/* -------------------------------------------------------------------------- */

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alertId: "alert-1",
    action: "BLOCK",
    targets: [{ kind: "ADDRESS", value: "203.0.113.7", label: "scanner" }],
    reason: "Credential stuffing from this address against the auth service.",
    requestedBy: { id: "u-1", label: "Ada", role: "ADMIN" },
    detectedAt: AT,
    ...over,
  };
}

test("containment: a well-formed request is read exactly as written", () => {
  const read = readContainmentRequest(body());
  assert.ok(read.ok, read.ok ? "" : read.error);
  if (!read.ok) return;

  assert.equal(read.value.alertId, "alert-1");
  assert.equal(read.value.action, "BLOCK");
  assert.deepEqual(read.value.targets, [{ kind: "ADDRESS", value: "203.0.113.7", label: "scanner" }]);
  assert.equal(read.value.requestedBy.label, "Ada");
  assert.equal(read.value.detectedAt, AT);
});

test("containment: every refusal names what was wrong", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...body(), alertId: "" }, /name the detection it answers/],
    [{ ...body(), action: "NUKE" }, /is not an action this build knows \(BLOCK, QUARANTINE, RATE_LIMIT\)/],
    [{ ...body(), targets: [] }, /at least one target/],
    [{ ...body(), targets: [{ kind: "MOON", value: "x" }] }, /is not a target kind this build knows/],
    [{ ...body(), targets: [{ kind: "ADDRESS", value: "  " }] }, /A ADDRESS target needs a value/],
    [{ ...body(), reason: "   " }, /needs a reason/],
    // No label *and* no id: a request nobody is named on is unauditable, and the reader falls
    // back to the id before refusing so a caller that only sends one of the two still works.
    [{ ...body(), requestedBy: { id: "", label: "", role: "ADMIN" } }, /name who asked for it/],
  ];

  for (const [payload, pattern] of cases) {
    const read = readContainmentRequest(payload);
    assert.equal(read.ok, false, `expected a refusal for ${JSON.stringify(payload)}`);
    if (!read.ok) assert.match(read.error, pattern);
  }

  assert.equal(readContainmentRequest(null).ok, false);
  assert.equal(readContainmentRequest("not an object").ok, false);
  assert.equal(readContainmentRequest({}).ok, false);
});

test("containment: a desk role maps explicitly, and an unknown one is refused rather than defaulted", () => {
  // The family's vocabulary and the desk's, both accepted.
  assert.equal(mapDeskRole("ADMIN"), "ADMIN");
  assert.equal(mapDeskRole("sysadmin"), "ADMIN");
  assert.equal(mapDeskRole("ANALYST"), "AGENT");
  assert.equal(mapDeskRole("TECHNICIAN"), "AGENT");
  assert.equal(mapDeskRole("DISPATCHER"), "AGENT", "a dispatcher owns the queue, not the network");
  assert.equal(mapDeskRole("AUDITOR"), "AUDITOR");
  assert.equal(mapDeskRole("SERVICE"), "SERVICE");
  // A requester, a student or a typo: refused, never quietly granted.
  assert.equal(mapDeskRole("REQUESTER"), null);
  assert.equal(mapDeskRole("STUDENT"), null);
  assert.equal(mapDeskRole(""), null);

  const read = readContainmentRequest(body({ requestedBy: { id: "u-9", label: "Ada", role: "STUDENT" } }));
  assert.equal(read.ok, false);
  if (!read.ok) assert.match(read.error, /is not a desk role this deployment can map/);
});

test("containment: the reply is a state, and its status says whether a retry could help", () => {
  assert.deepEqual(containmentReply({ gate: "IMMEDIATE", actionId: "act-1", state: "ACTIVE" }), {
    outcome: "APPLIED",
    actionId: "act-1",
    state: "ACTIVE",
    reason: null,
  });
  assert.equal(containmentReply({ gate: "APPROVAL_REQUIRED", actionId: "act-2", state: "PENDING" }).outcome, "PENDING");

  // Pending is a `202`, not a failure: a desk that treated "waiting for an approver" as an error
  // would retry a request that is working exactly as designed.
  assert.equal(containmentStatus(containmentReply({ gate: "APPROVAL_REQUIRED", actionId: "a", state: "PENDING" })), 202);
  assert.equal(containmentStatus(containmentRefusal("protected")), 409);
  assert.match(describeContainment(containmentRefusal("Refused: on the safe-list.")), /Sentinel refused.*safe-list/);
  assert.match(describeContainment(containmentReply({ gate: "APPROVAL_REQUIRED", actionId: "a", state: "PENDING" })), /Nothing is blocked yet/);
});

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

async function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const entities = new MemoryIdentityStore();
  let n = 0;
  const spine = new IdentityService(entities, audit, {
    id: () => `ct-id-${++n}`,
    now: () => AT,
    nowMs: () => Date.parse(AT),
  });
  const created = await spine.bootstrapOrganization("test", { name: "Acme Inc", slug: "acme" }, {
    identifier: "admin@acme.test",
    displayName: "Admin",
  });
  assert.ok(created.ok, created.ok ? "" : created.error);

  const store = new MemoryEnforcementStore();
  const enforcement = new EnforcementService(store, audit, {
    id: (() => {
      let m = 0;
      return () => `en-${++m}`;
    })(),
    now: () => AT,
  });
  const detection = new DetectionService(new MemoryAlertStore(), entities, audit, undefined, undefined, sha256);
  const guard = new GuardService(detection, entities, { token: "ingest-token", organizationSlug: null }, enforcement);

  return { audit, entities, enforcement, store, guard, organizationId: created.value.organization.id };
}

test("containment: a desk request becomes a proposal on Sentinel's own rails", async () => {
  const h = await harness();

  const result = await h.guard.containment({
    authorization: "Bearer ingest-token",
    organization: "acme",
    body: body(),
  });
  assert.ok(result.ok, result.ok ? "" : result.error);
  if (!result.ok) return;

  // The default policy wants a second administrator, and the desk's requester is never that
  // person — so a desk request lands pending, which is the design rather than a limitation.
  assert.equal(result.value.outcome, "PENDING");
  assert.equal(result.value.state, "PENDING");
  assert.ok(result.value.actionId, "the desk is given the action's id to point at");

  const [action] = await h.enforcement.list(h.organizationId);
  assert.equal(action.state, "PENDING");
  assert.equal(action.alertId, "alert-1");
  assert.equal(action.requestedById, "tix:u-1", "the requester is namespaced, so it cannot be confused with an identity here");
  assert.equal(action.requestedByLabel, "Ada (OnTrak Tix)");
  assert.equal(action.requestedByRole, "ADMIN");
  assert.equal(action.detectedAt, AT, "the detection instant travels, so time-to-prevent is measurable");
  assert.deepEqual(action.targets, [{ kind: "ADDRESS", value: "203.0.113.7", label: "scanner" }]);
  assert.equal(action.timeToPreventMs, null, "a pending proposal has prevented nothing yet");

  // The proposal is on the organization's chain with the desk named as who asked.
  const raised = h.audit.trail(h.organizationId).find((entry) => entry.action === "enforcement.proposed");
  assert.ok(raised, "the proposal is on the chain");
  assert.equal(raised?.actor, "tix:u-1");
});

test("containment: the rails decide, and a refusal is an outcome the desk can show", async () => {
  const h = await harness();

  // A safe-list entry the desk does not know about. It is checked before anything about who is
  // asking, so even an administrator's request is refused rather than grandfathered past.
  const policy = await h.enforcement.setPolicy(
    h.organizationId,
    { ...DEFAULT_ENFORCEMENT_POLICY, protectedTargets: ["203.0.113.7"], maxTargets: 5, requireSecondApprover: false },
    { identityId: "root", label: "Root" },
  );
  assert.ok(policy.ok, policy.ok ? "" : policy.error);

  const refused = await h.guard.containment({ authorization: "Bearer ingest-token", organization: "acme", body: body() });
  assert.ok(refused.ok, refused.ok ? "" : refused.error);
  if (!refused.ok) return;
  assert.equal(refused.value.outcome, "REFUSED");
  assert.equal(refused.value.actionId, null);
  assert.match(refused.value.reason ?? "", /safe-list/);

  // And the refusal is on the chain, because an attempt a rail stopped is evidence too.
  assert.ok(h.audit.trail(h.organizationId).some((entry) => entry.action === "enforcement.refused"));

  // A blast radius over the cap is refused rather than truncated — a smaller action than the one
  // described is a *different* action from the one somebody approved.
  const wide = await h.guard.containment({
    authorization: "Bearer ingest-token",
    organization: "acme",
    body: body({
      targets: [
        { kind: "ADDRESS", value: "198.51.100.1" },
        { kind: "ADDRESS", value: "198.51.100.2" },
        { kind: "ADDRESS", value: "198.51.100.3" },
        { kind: "ADDRESS", value: "198.51.100.4" },
        { kind: "ADDRESS", value: "198.51.100.5" },
        { kind: "ADDRESS", value: "198.51.100.6" },
      ],
    }),
  });
  assert.ok(wide.ok);
  assert.equal(wide.ok && wide.value.outcome, "REFUSED");
  assert.match((wide.ok && wide.value.reason) || "", /cap of 5/);
});

test("containment: the token is checked, and the tenant is looked up rather than trusted", async () => {
  const h = await harness();

  const noToken = await h.guard.containment({ authorization: "", organization: "acme", body: body() });
  assert.equal(noToken.ok, false);
  assert.match(noToken.ok ? "" : noToken.error, /containment token is not valid/);

  const wrongToken = await h.guard.containment({ authorization: "Bearer nope", organization: "acme", body: body() });
  assert.equal(wrongToken.ok, false);

  const unknownOrg = await h.guard.containment({ authorization: "Bearer ingest-token", organization: "nope", body: body() });
  assert.equal(unknownOrg.ok, false);
  assert.match(unknownOrg.ok ? "" : unknownOrg.error, /No organization has the slug/);

  const noOrg = await h.guard.containment({ authorization: "Bearer ingest-token", organization: "", body: body() });
  assert.equal(noOrg.ok, false);
});

test("containment: a deployment with no containment token or no enforcement says so", async () => {
  const h = await harness();
  const detection = new DetectionService(new MemoryAlertStore(), h.entities, h.audit, undefined, undefined, sha256);

  const noEnforcement = new GuardService(detection, h.entities, { token: "ingest-token", organizationSlug: null });
  assert.equal(noEnforcement.containmentEnabled(), true, "the ingest token is the fallback credential");
  const answered = await noEnforcement.containment({ authorization: "Bearer ingest-token", organization: "acme", body: body() });
  assert.equal(answered.ok, false);
  assert.match(answered.ok ? "" : answered.error, /runs no enforcement service/);

  // A deployment that names a *dedicated* containment token requires it: the ingest credential
  // every sensor in the estate holds must not be able to take a host off the network.
  const dedicated = new GuardService(
    detection,
    h.entities,
    { token: "ingest-token", organizationSlug: null, containmentToken: "containment-token" },
    h.enforcement,
  );
  assert.equal((await dedicated.containment({ authorization: "Bearer ingest-token", organization: "acme", body: body() })).ok, false);
  assert.equal((await dedicated.containment({ authorization: "Bearer containment-token", organization: "acme", body: body() })).ok, true);
});

/* -------------------------------------------------------------------------- */
/*  Through the router                                                        */
/* -------------------------------------------------------------------------- */

function request(method: string, path: string, body: unknown, headers: Record<string, string> = {}): HttpRequest {
  return {
    method,
    url: `https://guard.sentinel.test${path}`,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

test("containment: the router maps the answer onto a status and keeps auth separate", async () => {
  const h = await harness();

  const accepted = await routeGuard(request("POST", GUARD_PATHS.containment, body(), { authorization: "Bearer ingest-token", "x-sentinel-organization": "acme" }), h.guard);
  assert.equal(accepted.status, 202);
  const parsed = JSON.parse(accepted.body) as { outcome: string; actionId: string };
  assert.equal(parsed.outcome, "PENDING");
  assert.ok(parsed.actionId);

  // A body the reader refuses is a `400` — the request was understood well enough to say what is
  // wrong with it — while a wrong token is a `401`.
  const badBody = await routeGuard(request("POST", GUARD_PATHS.containment, { action: "BLOCK" }, { authorization: "Bearer ingest-token" }), h.guard);
  assert.equal(badBody.status, 400);

  const unauthorized = await routeGuard(request("POST", GUARD_PATHS.containment, body(), { authorization: "Bearer nope" }), h.guard);
  assert.equal(unauthorized.status, 401);

  const notJson = await routeGuard(
    { method: "POST", url: `https://guard.sentinel.test${GUARD_PATHS.containment}`, headers: { authorization: "Bearer ingest-token" }, body: "{" },
    h.guard,
  );
  assert.equal(notJson.status, 400);

  const wrongMethod = await routeGuard(request("GET", GUARD_PATHS.containment, undefined, { authorization: "Bearer ingest-token" }), h.guard);
  assert.equal(wrongMethod.status, 405);

  // A refusal keeps the `409`, which is what tells a caller that a retry cannot help.
  const policy = await h.enforcement.setPolicy(
    h.organizationId,
    { ...DEFAULT_ENFORCEMENT_POLICY, protectedTargets: ["203.0.113.7"], maxTargets: 5 },
    { identityId: "root", label: "Root" },
  );
  assert.ok(policy.ok);
  const refused = await routeGuard(request("POST", GUARD_PATHS.containment, body(), { authorization: "Bearer ingest-token", "x-sentinel-organization": "acme" }), h.guard);
  assert.equal(refused.status, 409);
  assert.equal((JSON.parse(refused.body) as { outcome: string }).outcome, "REFUSED");
});
