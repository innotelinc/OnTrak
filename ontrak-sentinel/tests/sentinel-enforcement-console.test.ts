/**
 * OnTrak Sentinel S4 tests: prevention an operator can take and undo.
 *
 * The milestone's promise is that a threat is *blocked* within a defined latency and the
 * block is approved, logged, reversible, and cannot be applied to a protected target. The
 * rules module and the service were tested without a socket (`sentinel-enforcement.test.ts`,
 * `sentinel-enforcement-service.test.ts`); this suite is the surface a person actually
 * reaches — the page that shows what is in force, the forms that propose, approve and lift,
 * and the timer that makes a TTL mean something.
 *
 * Each test follows one way that can go wrong:
 *
 *  - a register of what is being blocked, reachable without a session or by somebody who is
 *    not an administrator;
 *  - a policy that can be written by anybody, or a target that reaches enforcement because
 *    the *page* forgot the safe-list rather than because the decision applied it;
 *  - an approval that the requester can give themselves;
 *  - a lift that is refused, which would make an outage permanent;
 *  - and an expiry that never fires, which is a TTL that is a promise rather than a mechanism.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import { CONSOLE_PATHS, CONSOLE_SESSION_COOKIE } from "../src/lib/console-rules";
import { ConsoleService } from "../src/lib/console-service";
import { routeConsole } from "../src/lib/console-http";
import {
  EnforcementService,
  MemoryEnforcementStore,
  type EnforcementActionRecord,
} from "../src/lib/enforcement-service";
import { parseTargetLines } from "../src/lib/enforcement-rules";
import {
  DEFAULT_ENFORCEMENT_SWEEP_INTERVAL_MS,
  MIN_ENFORCEMENT_SWEEP_INTERVAL_MS,
  enforcementSweepIntervalMs,
  startEnforcementScheduler,
} from "../src/lib/enforcement-scheduler";
import { sha256Hex } from "../src/lib/hash";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog, type IdentityActor } from "../src/lib/identity-service";
import { MemoryMfaStore, MfaService } from "../src/lib/mfa-service";
import type { HttpRequest } from "../src/lib/oidc-http";

const sha256: HashFn = sha256Hex;
const ORIGIN = "https://id.sentinel.test";

/* -------------------------------------------------------------------------- */
/*  Reading the target box                                                    */
/* -------------------------------------------------------------------------- */

test("targets: the box reads a bare address, a named kind and a label", () => {
  const targets = parseTargetLines(
    [
      "203.0.113.7 -- comment after a # is not a comment",
      "# a whole-line comment is skipped",
      "",
      "IDENTITY 8f3c-aa11 the compromised person",
      "DEVICE dev-42",
      "  10.0.0.9   scanner  ",
    ].join("\n"),
  );

  assert.deepEqual(targets, [
    // A bare line is an address: the common case is an operator pasting addresses, and a box
    // that refused those until they typed `ADDRESS` in front of each would be unused.
    { kind: "ADDRESS", value: "203.0.113.7", label: "-- comment after a # is not a comment" },
    { kind: "IDENTITY", value: "8f3c-aa11", label: "the compromised person" },
    { kind: "DEVICE", value: "dev-42" },
    { kind: "ADDRESS", value: "10.0.0.9", label: "scanner" },
  ]);

  assert.deepEqual(parseTargetLines(""), [], "an empty box is no targets, not an error");
  // A named kind with no value is dropped rather than becoming a target of `undefined`.
  assert.deepEqual(parseTargetLines("ADDRESS"), []);
});

/* -------------------------------------------------------------------------- */
/*  The console surface                                                       */
/* -------------------------------------------------------------------------- */

let harnessSeq = 0;

function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  const store = new MemoryEnforcementStore();
  const scope = `e${++harnessSeq}`;
  let clock = Date.parse("2026-11-01T09:00:00.000Z");
  let n = 0;

  const spine = new IdentityService(identities, audit, {
    id: () => `${scope}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  });
  const mfa = new MfaService(new MemoryMfaStore(), spine, audit, {
    id: () => `${scope}-factor-${++n}`,
    secret: () => "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  });
  const enforcement = new EnforcementService(store, audit, {
    id: () => `${scope}-enf-${++n}`,
    now: () => new Date(clock).toISOString(),
  });
  // Positional, like the deployment's own wiring: prevention is the last collaborator and
  // everything between the second argument and it is a console feature this suite does not
  // exercise (no token store, no SCIM, no sign-in service, no directory, no intel, no
  // detection, no upstream, no access reviews).
  const service = new ConsoleService(
    spine,
    mfa,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    enforcement,
  );

  async function sessionFor(actor: IdentityActor, identityId: string) {
    const enrolled = await spine.setMfaEnrolled(actor, identityId, true);
    assert.ok(enrolled.ok, enrolled.ok ? "" : enrolled.error);
    const session = await spine.issueSession(actor.organizationId, identityId);
    assert.ok(session.ok, session.ok ? "" : session.error);
    return session.value.id;
  }

  return {
    spine,
    store,
    enforcement,
    service,
    nowMs: () => clock,
    advance(ms: number) {
      clock += ms;
    },
    async organization(slug: string) {
      const created = await spine.bootstrapOrganization("test", { name: `${slug} Inc`, slug }, {
        identifier: `admin@${slug}.test`,
        displayName: `Admin ${slug}`,
      });
      assert.ok(created.ok, created.ok ? "" : created.error);
      const actor: IdentityActor = {
        id: created.value.admin.id,
        organizationId: created.value.organization.id,
        role: "ADMIN",
      };
      return { actor, sessionId: await sessionFor(actor, actor.id) };
    },
    /** A second administrator, for the approvals the policy requires. */
    async secondAdmin(actor: IdentityActor, organizationId: string, slug: string) {
      const created = await spine.createIdentity(actor, {
        identifier: `second@${slug}.test`,
        displayName: `Second ${slug}`,
        role: "ADMIN",
      });
      assert.ok(created.ok, created.ok ? "" : created.error);
      const second: IdentityActor = { id: created.value.id, organizationId, role: "ADMIN" };
      return { actor: second, sessionId: await sessionFor(second, created.value.id) };
    },
    /** An ordinary member: the person the page must refuse. */
    async member(actor: IdentityActor, organizationId: string, slug: string) {
      const created = await spine.createIdentity(actor, {
        identifier: `member@${slug}.test`,
        displayName: `Member ${slug}`,
        role: "AGENT",
      });
      assert.ok(created.ok, created.ok ? "" : created.error);
      const member: IdentityActor = { id: created.value.id, organizationId, role: "AGENT" };
      return { actor: member, sessionId: await sessionFor(member, created.value.id) };
    },
  };
}

function request(
  method: string,
  path: string,
  options: { sessionId?: string | null; body?: string } = {},
): HttpRequest {
  const headers: Record<string, string | undefined> = {};
  const cookies: Record<string, string> = {};
  if (options.sessionId) cookies[CONSOLE_SESSION_COOKIE] = options.sessionId;
  if (options.body) headers["content-type"] = "application/x-www-form-urlencoded";
  return { method, url: `${ORIGIN}${path}`, headers, body: options.body, cookies };
}

/** The form body the page would submit. */
function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

test("enforcement: the register is behind an administrator, and an absent service says so", async () => {
  const h = harness();
  const { actor, sessionId } = await h.organization("acme");

  // A register of what an organization is blocking is not a public page.
  const anonymous = await routeConsole(request("GET", CONSOLE_PATHS.enforcement), h.service);
  assert.equal(anonymous.status, 303, "prevention is not a public page");
  assert.equal(anonymous.headers.location, CONSOLE_PATHS.signIn);
  assert.equal(anonymous.headers["cache-control"], "no-store");

  // Neither is it a page for everybody inside: a member is told, by the service, rather than
  // shown a safe-list.
  const member = await h.member(actor, actor.organizationId, "acme");
  const memberPage = await routeConsole(
    request("GET", CONSOLE_PATHS.enforcement, { sessionId: member.sessionId }),
    h.service,
  );
  assert.equal(memberPage.status, 400);
  // The refusal is escaped on the error page, which is its own small assertion that the
  // service's sentence is HTML, not markup.
  assert.match(memberPage.body, /administrator&#39;s surface/);

  // A deployment that wired no enforcement says so rather than showing an empty register.
  const bare = new ConsoleService(h.spine, new MfaService(new MemoryMfaStore(), h.spine));
  const refused = await routeConsole(request("GET", CONSOLE_PATHS.enforcement, { sessionId }), bare);
  assert.equal(refused.status, 400);
  assert.match(refused.body, /runs no enforcement service/);

  // Every act on the register is a POST: a read cannot block a network.
  const wrongVerb = await routeConsole(request("GET", CONSOLE_PATHS.enforcementPropose, { sessionId }), h.service);
  assert.equal(wrongVerb.status, 405);
  assert.equal(wrongVerb.headers.allow, "POST");

  // And the page renders for an administrator, naming the policy in force.
  const page = await routeConsole(request("GET", CONSOLE_PATHS.enforcement, { sessionId }), h.service);
  assert.equal(page.status, 200);
  assert.match(page.body, /In force/);
  assert.match(page.body, /Nothing is being enforced against right now/);
  assert.match(page.body, /built-in default is in force/);
});

test("enforcement: an administrator proposes, and a policy that needs no second admin applies it now", async () => {
  const h = harness();
  const { actor, sessionId } = await h.organization("acme");

  // Relax the default so the proposer's own action takes effect: the decision still checks
  // the safe-list, the blast radius and the rate limit.
  const saved = await h.enforcement.setPolicy(
    actor.organizationId,
    {
      protectedTargets: [],
      maxTargets: 2,
      maxActionsPerHour: 10,
      defaultTtlSeconds: 3600,
      allowPermanent: false,
      requireSecondApprover: false,
    },
    { identityId: actor.id, label: "Admin acme" },
  );
  assert.ok(saved.ok, saved.ok ? "" : saved.error);

  const proposed = await routeConsole(
    request("POST", CONSOLE_PATHS.enforcementPropose, {
      sessionId,
      body: form({
        action: "BLOCK",
        alertId: "alert-1",
        reason: "credential stuffing from this address",
        targets: "ADDRESS 203.0.113.7 scanner",
      }),
    }),
    h.service,
  );
  assert.equal(proposed.status, 303);
  assert.match(decodeURIComponent(String(proposed.headers.location)), /BLOCK is in force/);

  const page = await routeConsole(request("GET", CONSOLE_PATHS.enforcement, { sessionId }), h.service);
  assert.equal(page.status, 200);
  assert.match(page.body, /BLOCK/);
  assert.match(page.body, /203\.0\.113\.7/);
  assert.match(page.body, /credential stuffing/);
  assert.match(page.body, /lifts itself/);
});

test("enforcement: the default policy makes a proposal wait, and the requester cannot approve it", async () => {
  const h = harness();
  const { actor, sessionId } = await h.organization("acme");
  const second = await h.secondAdmin(actor, actor.organizationId, "acme");

  const proposed = await routeConsole(
    request("POST", CONSOLE_PATHS.enforcementPropose, {
      sessionId,
      body: form({
        action: "QUARANTINE",
        alertId: "alert-2",
        reason: "host beaconing out",
        targets: "DEVICE dev-42 the suspect host",
      }),
    }),
    h.service,
  );
  assert.equal(proposed.status, 303);
  assert.match(decodeURIComponent(String(proposed.headers.location)), /has to approve it before it takes effect/);

  const waiting = await h.enforcement.list(actor.organizationId);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0]!.state, "PENDING");

  // The requester approving their own action is refused by the service, which is where the
  // rule about a second pair of eyes lives.
  const selfApprove = await routeConsole(
    request("POST", CONSOLE_PATHS.enforcementApprove, {
      sessionId,
      body: form({ actionId: waiting[0]!.id }),
    }),
    h.service,
  );
  assert.equal(selfApprove.status, 400);
  assert.match(selfApprove.body, /cannot approve their own action/);

  // The second administrator approves, and the action is in force.
  const approved = await routeConsole(
    request("POST", CONSOLE_PATHS.enforcementApprove, {
      sessionId: second.sessionId,
      body: form({ actionId: waiting[0]!.id }),
    }),
    h.service,
  );
  assert.equal(approved.status, 303);
  assert.match(decodeURIComponent(String(approved.headers.location)), /QUARANTINE is in force/);
  const inForce = await h.enforcement.inForce(actor.organizationId);
  assert.equal(inForce.length, 1);
  assert.equal(inForce[0]!.approvedByLabel, "Second acme");
});

test("enforcement: a protected target is refused by the decision, not by the page", async () => {
  const h = harness();
  const { actor, sessionId } = await h.organization("acme");

  const saved = await h.enforcement.setPolicy(
    actor.organizationId,
    {
      protectedTargets: ["10.0.0.0/8"],
      maxTargets: 4,
      maxActionsPerHour: 10,
      defaultTtlSeconds: 3600,
      allowPermanent: false,
      requireSecondApprover: false,
    },
    { identityId: actor.id, label: "Admin acme" },
  );
  assert.ok(saved.ok, saved.ok ? "" : saved.error);

  const refused = await routeConsole(
    request("POST", CONSOLE_PATHS.enforcementPropose, {
      sessionId,
      body: form({
        action: "BLOCK",
        alertId: "alert-3",
        reason: "looks suspicious",
        targets: "ADDRESS 10.0.0.9 the database",
      }),
    }),
    h.service,
  );
  assert.equal(refused.status, 400);
  assert.match(refused.body, /safe-list/);
  // A refused proposal never existed: no action was stored.
  assert.deepEqual(await h.enforcement.list(actor.organizationId), []);
});

test("enforcement: an action in force can be lifted by hand, which is never refused", async () => {
  const h = harness();
  const { actor, sessionId } = await h.organization("acme");

  await h.enforcement.setPolicy(
    actor.organizationId,
    {
      protectedTargets: [],
      maxTargets: 2,
      maxActionsPerHour: 10,
      defaultTtlSeconds: 3600,
      allowPermanent: false,
      requireSecondApprover: false,
    },
    { identityId: actor.id, label: "Admin acme" },
  );

  await routeConsole(
    request("POST", CONSOLE_PATHS.enforcementPropose, {
      sessionId,
      body: form({ action: "RATE_LIMIT", alertId: "alert-4", reason: "flooding us", targets: "203.0.113.9" }),
    }),
    h.service,
  );
  const [inForce] = await h.enforcement.inForce(actor.organizationId);
  assert.ok(inForce);

  const lifted = await routeConsole(
    request("POST", CONSOLE_PATHS.enforcementLift, {
      sessionId,
      body: form({ actionId: inForce.id, reason: "false positive, the scanner is ours" }),
    }),
    h.service,
  );
  assert.equal(lifted.status, 303);
  assert.match(decodeURIComponent(String(lifted.headers.location)), /RATE_LIMIT lifted/);
  assert.deepEqual(await h.enforcement.inForce(actor.organizationId), []);

  // Nobody is left holding a block they cannot undo, even with no reason typed.
  await routeConsole(
    request("POST", CONSOLE_PATHS.enforcementPropose, {
      sessionId,
      body: form({ action: "BLOCK", alertId: "alert-5", reason: "again", targets: "203.0.113.10" }),
    }),
    h.service,
  );
  const [second] = await h.enforcement.inForce(actor.organizationId);
  const liftedBlank = await routeConsole(
    request("POST", CONSOLE_PATHS.enforcementLift, { sessionId, body: form({ actionId: second!.id, reason: "" }) }),
    h.service,
  );
  assert.equal(liftedBlank.status, 303, "a lift with no note still lifts");
});

test("enforcement: a policy is written through the page, and an invalid one is refused by name", async () => {
  const h = harness();
  const { sessionId } = await h.organization("acme");

  const saved = await routeConsole(
    request("POST", CONSOLE_PATHS.enforcementPolicy, {
      sessionId,
      body: form({
        protectedTargets: "# our core\n10.0.0.0/8\n\nidentity-critical",
        maxTargets: "3",
        maxActionsPerHour: "20",
        defaultTtlSeconds: "900",
        requireSecondApprover: "1",
      }),
    }),
    h.service,
  );
  assert.equal(saved.status, 303);
  assert.match(decodeURIComponent(String(saved.headers.location)), /policy is saved/);

  const page = await routeConsole(request("GET", CONSOLE_PATHS.enforcement, { sessionId }), h.service);
  assert.equal(page.status, 200);
  assert.match(page.body, /has written its own policy/);
  assert.match(page.body, /10\.0\.0\.0\/8/);
  assert.match(page.body, /identity-critical/);

  // A negative blast radius is a typo somebody should see, not a stored policy that means
  // nothing — the service validates, and the page surfaces what it said.
  const bad = await routeConsole(
    request("POST", CONSOLE_PATHS.enforcementPolicy, {
      sessionId,
      body: form({
        protectedTargets: "",
        maxTargets: "0",
        maxActionsPerHour: "20",
        defaultTtlSeconds: "900",
        requireSecondApprover: "1",
      }),
    }),
    h.service,
  );
  assert.equal(bad.status, 400);
  assert.match(bad.body, /blast-radius cap/);
});

test("enforcement: a sweep lifts what its own deadline reached, and the interval defaults on", async () => {
  const h = harness();
  const { actor } = await h.organization("acme");

  await h.enforcement.setPolicy(
    actor.organizationId,
    {
      protectedTargets: [],
      maxTargets: 2,
      maxActionsPerHour: 10,
      defaultTtlSeconds: 3600,
      allowPermanent: false,
      requireSecondApprover: false,
    },
    { identityId: actor.id, label: "Admin acme" },
  );

  const applied = await h.enforcement.apply({
    organizationId: actor.organizationId,
    proposal: {
      action: "BLOCK",
      targets: [{ kind: "ADDRESS", value: "198.51.100.7" }],
      alertId: "alert-6",
      reason: "mission control says so",
      requestedBy: { identityId: actor.id, label: "Admin acme", role: "ADMIN" },
    },
  });
  assert.ok(applied.ok, applied.ok ? "" : applied.error);
  assert.equal(applied.value.action.expiresAt !== null, true, "an hour's TTL is a real deadline");
  assert.equal((await h.enforcement.inForce(actor.organizationId)).length, 1);

  // Nothing to lift yet.
  assert.deepEqual(await h.enforcement.sweepExpired(), { lifted: [] });

  // An hour and a second later, the sweep lifts it — with no operator involved.
  h.advance(3601 * 1000);
  const swept = await h.enforcement.sweepExpired();
  assert.deepEqual(swept.lifted, [applied.value.action.id]);
  assert.deepEqual(await h.enforcement.inForce(actor.organizationId), []);

  // Idempotent: a second sweep does nothing rather than writing a second lift row.
  assert.deepEqual(await h.enforcement.sweepExpired(), { lifted: [] });

  // Unset is ON, at a minute — the opposite of scheduled attestation, because the
  // alternative to a sweep is a block that outlives the lifetime it was applied with.
  assert.equal(enforcementSweepIntervalMs({}), DEFAULT_ENFORCEMENT_SWEEP_INTERVAL_MS);
  assert.equal(enforcementSweepIntervalMs({ SENTINEL_ENFORCEMENT_SWEEP_INTERVAL_MINUTES: "0" }), null);
  assert.equal(enforcementSweepIntervalMs({ SENTINEL_ENFORCEMENT_SWEEP_INTERVAL_MINUTES: "-1" }), null);
  assert.equal(
    enforcementSweepIntervalMs({ SENTINEL_ENFORCEMENT_SWEEP_INTERVAL_MINUTES: "5" }),
    5 * 60_000,
  );
  // A fraction is clamped up to the floor rather than meaning “busy loop”.
  assert.equal(
    enforcementSweepIntervalMs({ SENTINEL_ENFORCEMENT_SWEEP_INTERVAL_MINUTES: "0.001" }),
    MIN_ENFORCEMENT_SWEEP_INTERVAL_MS,
  );
});

test("enforcement: the register states the measured time-to-prevent, and says when it has none", async () => {
  const h = harness();
  const { actor, sessionId } = await h.organization("acme");

  // Nothing has been prevented, so the page says so rather than printing 0 ms — an absent
  // measurement and an instant one are different facts and must not read alike.
  const empty = await routeConsole(request("GET", CONSOLE_PATHS.enforcement, { sessionId }), h.service);
  assert.equal(empty.status, 200);
  assert.match(empty.body, /No action carries a measured time-to-prevent yet/);

  // Seed one settled action the way the service writes it — the interval measured at the
  // moment it went in force. The store is written directly because this suite wires no
  // detection pipeline to propose from; the measurement itself is the service's own test.
  const at = new Date(h.nowMs()).toISOString();
  const action: EnforcementActionRecord = {
    id: "enf-tttp",
    organizationId: actor.organizationId,
    action: "BLOCK",
    state: "ACTIVE",
    targets: [{ kind: "ADDRESS", value: "203.0.113.9", label: "the C2 host" }],
    alertId: "alert-tttp",
    reason: "Beaconing to a known C2 address.",
    requestedById: actor.id,
    requestedByLabel: "Admin acme",
    requestedByRole: "ADMIN",
    approvedById: actor.id,
    approvedByLabel: "Admin acme",
    appliedAt: at,
    expiresAt: null,
    detectedAt: new Date(h.nowMs() - 90_000).toISOString(),
    timeToPreventMs: 90_000,
    liftedAt: null,
    liftedById: null,
    liftedByLabel: null,
    liftReason: null,
    refusedCode: null,
    refusedReason: null,
    rollback: null,
    createdAt: at,
    updatedAt: at,
  };
  await h.store.saveAction(action);

  const page = await routeConsole(request("GET", CONSOLE_PATHS.enforcement, { sessionId }), h.service);
  assert.equal(page.status, 200);
  // The headline figure S4's exit is judged on, and the row it came from beside it.
  assert.match(page.body, /Measured time-to-prevent: <strong>1m 30s<\/strong>/);
  assert.match(page.body, /median of 1; fastest 1m 30s, slowest 1m 30s/);
  assert.match(page.body, /prevented in 1m 30s/);
  assert.doesNotMatch(page.body, /No action carries a measured time-to-prevent yet/);
});

test("enforcement: the scheduler runs its sweep, reports failures, and stops cleanly", async () => {
  const lines: string[] = [];
  let swept = 0;
  let fail = false;
  const service = {
    async sweepExpired() {
      swept += 1;
      if (fail) throw new Error("the database is away");
      return { lifted: swept === 1 ? ["a"] : [] };
    },
  };

  let tick: (() => void) | null = null;
  let cleared = false;
  const scheduler = startEnforcementScheduler(service, {
    intervalMs: 1000,
    log: (message) => lines.push(message),
    setTimer: (callback) => {
      tick = callback;
      return { unref: () => undefined };
    },
    clearTimer: () => {
      cleared = true;
    },
  });

  assert.match(lines[0]!, /expiry sweep is on/);
  await scheduler.runOnce();
  assert.equal(swept, 1);
  assert.match(lines.find((line) => line.includes("lifted"))!, /lifted 1 action/);

  // A failing sweep is logged and does not escape the timer.
  fail = true;
  await scheduler.runOnce();
  assert.ok(lines.some((line) => /sweep failed: the database is away/.test(line)));

  // The injected timer would drive it, and `stop` clears it.
  assert.ok(tick);
  scheduler.stop();
  assert.equal(cleared, true);
});
