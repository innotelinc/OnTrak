/**
 * OnTrak Sentinel S1 tests: per-role session policies.
 *
 * S0 had one policy per organization and everybody read it. These tests are about
 * the four ways "a policy per role" can be wrong:
 *
 *  - the *order* of resolution (a role row beats the baseline; the baseline beats the
 *    built-in default) — get this backwards and an organization that deliberately
 *    loosened its baseline is ignored for every role it did not name;
 *  - a policy that does not mean what it says (an idle timeout longer than the
 *    session's own lifetime can never fire, so a deployment would believe two
 *    controls were on while only one was);
 *  - a policy that is stored but not *asked* — the login path, not the console page,
 *    is where a policy has to be true;
 *  - and a scope that leaks: an override for one role must not change what any other
 *    role is judged by.
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
  DEFAULT_IDENTITY_POLICY,
  POLICY_MAX_SESSION_SECONDS,
  policyForRole,
  validatePolicy,
  type PolicyRecord,
} from "../src/lib/identity-rules";
import { sha256Hex } from "../src/lib/hash";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog, type IdentityActor } from "../src/lib/identity-service";
import { MemoryMfaStore, MfaService, type MfaIds } from "../src/lib/mfa-service";
import type { HttpRequest } from "../src/lib/oidc-http";

const sha256: HashFn = sha256Hex;

/* -------------------------------------------------------------------------- */
/*  The pure rule, on its own                                                 */
/* -------------------------------------------------------------------------- */

function row(scope: string, over: Partial<PolicyRecord> = {}): PolicyRecord {
  return {
    organizationId: "org",
    scope: scope as PolicyRecord["scope"],
    requireMfa: true,
    maxSessionSeconds: 3600,
    idleTimeoutSeconds: 600,
    updatedAt: "2026-10-25T00:00:00.000Z",
    ...over,
  };
}

test("policy: a role row beats the baseline, and the baseline beats the default", () => {
  const rows = [
    row("ALL", { requireMfa: false, maxSessionSeconds: 7200, idleTimeoutSeconds: 1800 }),
    row("AGENT", { requireMfa: true, maxSessionSeconds: 900, idleTimeoutSeconds: 300 }),
  ];

  // The role override, exactly.
  assert.deepEqual(policyForRole(rows, "AGENT"), { requireMfa: true, maxSessionSeconds: 900, idleTimeoutSeconds: 300 });
  // A role nobody named reads the organization's baseline — not the code's default.
  assert.deepEqual(policyForRole(rows, "AUDITOR"), { requireMfa: false, maxSessionSeconds: 7200, idleTimeoutSeconds: 1800 });
  // And with nothing stored at all, the built-in default still applies.
  assert.deepEqual(policyForRole([], "ADMIN"), DEFAULT_IDENTITY_POLICY);
});

test("policy: a baseline that loosens MFA is honoured for every role it does not name", () => {
  // The failure this guards against: falling back to the code's default the moment a
  // role row is missing, which would quietly re-impose `requireMfa` on a tenant that
  // had turned it off for everybody.
  const rows = [row("ALL", { requireMfa: false })];
  assert.equal(policyForRole(rows, "ADMIN").requireMfa, false);
  assert.equal(policyForRole(rows, "SERVICE").requireMfa, false);
});

test("policy: a policy that could never fire is refused by name", () => {
  const base = { scope: "ALL", requireMfa: true };

  // An idle timeout longer than the session's lifetime is a control that is not on.
  const idleLonger = validatePolicy({ ...base, maxSessionSeconds: 600, idleTimeoutSeconds: 900 });
  assert.equal(idleLonger.length, 1);
  assert.equal(idleLonger[0].field, "idleTimeoutSeconds");
  assert.match(idleLonger[0].message, /longer than the session's lifetime/);

  assert.equal(validatePolicy({ ...base, maxSessionSeconds: 600, idleTimeoutSeconds: 600 }).length, 0);

  // Zero is not "no timeout"; it is a typo the validator has to catch rather than
  // silently clamping, because a control somebody meant to tighten should not be
  // quietly rounded to something else.
  assert.equal(validatePolicy({ ...base, maxSessionSeconds: 0, idleTimeoutSeconds: 60 })[0].field, "maxSessionSeconds");
  assert.equal(validatePolicy({ ...base, maxSessionSeconds: 60, idleTimeoutSeconds: 0 })[0].field, "idleTimeoutSeconds");
  assert.equal(
    validatePolicy({ ...base, maxSessionSeconds: POLICY_MAX_SESSION_SECONDS + 1, idleTimeoutSeconds: 60 })[0].field,
    "maxSessionSeconds",
  );

  // A scope nobody recognises — including an empty one from a form with no field.
  assert.equal(validatePolicy({ ...base, scope: "ROOT", maxSessionSeconds: 600, idleTimeoutSeconds: 60 })[0].field, "scope");
  assert.equal(validatePolicy({ ...base, scope: "", maxSessionSeconds: 600, idleTimeoutSeconds: 60 })[0].field, "scope");
});

/* -------------------------------------------------------------------------- */
/*  The service, over the real spine                                          */
/* -------------------------------------------------------------------------- */

let seq = 0;

function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const store = new MemoryIdentityStore();
  let clock = Date.parse("2026-10-25T09:00:00.000Z");
  let n = 0;
  const tag = `p${++seq}`;
  const spine = new IdentityService(store, audit, {
    id: () => `${tag}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  });
  const mfaIds: MfaIds = {
    id: () => `${tag}-factor-${++n}`,
    secret: () => "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  const mfa = new MfaService(new MemoryMfaStore(), spine, audit, mfaIds);
  const service = new ConsoleService(spine, mfa);
  return { spine, mfa, audit, store, service, tag, nowMs: () => clock };
}

/**
 * An organization whose administrator holds a session.
 *
 * `enrolled` sets the enrolled *flag* directly rather than walking a real factor:
 * under the default policy a session cannot exist without one, and these tests are
 * about policies rather than about TOTP.
 */
async function organization(h: ReturnType<typeof harness>, slug: string, enrolled = true) {
  const created = await h.spine.bootstrapOrganization("test", { name: `${slug} Inc`, slug }, { identifier: `admin@${slug}.test`, displayName: "Admin" });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const actor: IdentityActor = { id: created.value.admin.id, organizationId: created.value.organization.id, role: "ADMIN" };
  if (enrolled) assert.ok((await h.spine.setMfaEnrolled(actor, actor.id, true)).ok);
  const session = await h.spine.issueSession(actor.organizationId, actor.id);
  assert.ok(session.ok, session.ok ? "" : session.error);
  return { actor, sessionId: session.value.id, organizationId: actor.organizationId };
}

async function addIdentity(h: ReturnType<typeof harness>, organizationId: string, identifier: string, role: "ADMIN" | "AGENT" | "AUDITOR", enrollMfa: boolean) {
  const created = await h.spine.createIdentity({ id: "root", organizationId, role: "ADMIN" }, { identifier, displayName: identifier, role });
  assert.ok(created.ok, created.ok ? "" : created.error);
  if (enrollMfa) {
    assert.ok((await h.spine.setMfaEnrolled({ id: created.value.id, organizationId, role }, created.value.id, true)).ok);
  }
  return created.value;
}

test("policy: only an administrator may write one, and the write lands on the chain", async () => {
  const h = harness();
  const { actor, organizationId } = await organization(h, "write", true);

  const auditor = await addIdentity(h, organizationId, "auditor@write.test", "AUDITOR", false);
  const auditorActor: IdentityActor = { id: auditor.id, organizationId, role: "AUDITOR" };

  const denied = await h.spine.setPolicy(auditorActor, "ALL", { requireMfa: false, maxSessionSeconds: 3600, idleTimeoutSeconds: 600 });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.error, /administer policies/);

  const refusedNumber = await h.spine.setPolicy(actor, "AGENT", { requireMfa: true, maxSessionSeconds: 600, idleTimeoutSeconds: 900 });
  assert.equal(refusedNumber.ok, false);

  const written = await h.spine.setPolicy(actor, "AGENT", { requireMfa: true, maxSessionSeconds: 900, idleTimeoutSeconds: 300 });
  assert.ok(written.ok, written.ok ? "" : written.error);
  assert.equal(written.value.scope, "AGENT");

  const trail = h.audit.trail(organizationId).filter((event) => event.action === "policy.update");
  assert.equal(trail.length, 1);
  assert.equal(trail[0].targetId, "AGENT");
  assert.equal((trail[0].detail as { maxSessionSeconds: number }).maxSessionSeconds, 900);
});

test("policy: writing the same scope twice updates the row rather than adding another", async () => {
  const h = harness();
  const { actor, organizationId } = await organization(h, "upsert", true);

  assert.ok((await h.spine.setPolicy(actor, "ALL", { requireMfa: false, maxSessionSeconds: 3600, idleTimeoutSeconds: 600 })).ok);
  assert.ok((await h.spine.setPolicy(actor, "ALL", { requireMfa: true, maxSessionSeconds: 7200, idleTimeoutSeconds: 1200 })).ok);

  const rows = await h.spine.policies(actor);
  assert.ok(rows.ok, rows.ok ? "" : rows.error);
  const all = rows.value.filter((entry) => entry.scope === "ALL");
  assert.equal(all.length, 1, "the baseline is one row an administrator edits, not a history of copies");
  assert.equal(all[0].maxSessionSeconds, 7200);
  // The pair really is the identity: one row per scope.
  assert.equal(h.store ? (await h.store.listPolicies(organizationId)).length : 1, 1);
});

test("policy: a role override changes only that role — and the login path is where it bites", async () => {
  const h = harness();
  const { actor, organizationId } = await organization(h, "enforce");

  // The baseline lets anybody hold a session without a second factor. This is what
  // makes the override below the only thing standing between the agent and a session.
  assert.ok((await h.spine.setPolicy(actor, "ALL", { requireMfa: false, maxSessionSeconds: 3600, idleTimeoutSeconds: 900 })).ok);

  const agent = await addIdentity(h, organizationId, "agent@enforce.test", "AGENT", false);
  const admin2 = await addIdentity(h, organizationId, "admin2@enforce.test", "ADMIN", false);

  const agentSession = await h.spine.issueSession(organizationId, agent.id);
  assert.ok(agentSession.ok, agentSession.ok ? "" : agentSession.error);
  const adminSession = await h.spine.issueSession(organizationId, admin2.id);
  assert.ok(adminSession.ok, "a role override must not leak into another role");

  // Now tighten AGENT only. The *same* identity is refused, and the refusal names the
  // reason — and the administrator is still allowed, because nothing about their role
  // changed.
  assert.ok((await h.spine.setPolicy(actor, "AGENT", { requireMfa: true, maxSessionSeconds: 900, idleTimeoutSeconds: 300 })).ok);

  const refused = await h.spine.issueSession(organizationId, agent.id);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /MFA is required/i);

  const stillFine = await h.spine.issueSession(organizationId, admin2.id);
  assert.ok(stillFine.ok, stillFine.ok ? "" : stillFine.error);

  // And the policy is asked at *read* as well as at grant: the agent's existing
  // session stops being usable on its very next check, which is the point of asking it
  // in one place.
  const check = await h.spine.checkSession(organizationId, agentSession.value.id);
  assert.equal(check.active, false);
  if (!check.active) assert.match(check.reason, /MFA is required/i);
});

test("policy: an auditor may read the policies and not write them", async () => {
  const h = harness();
  const { organizationId } = await organization(h, "read");
  const auditor = await addIdentity(h, organizationId, "auditor@read.test", "AUDITOR", false);
  const auditorActor: IdentityActor = { id: auditor.id, organizationId, role: "AUDITOR" };

  const read = await h.spine.policies(auditorActor);
  assert.ok(read.ok, read.ok ? "" : read.error);
  assert.deepEqual(read.value, []);

  // A SERVICE identity is not an administrator and not an auditor.
  const machine = await h.spine.createIdentity({ id: "root", organizationId, role: "ADMIN" }, {
    identifier: "svc@read.test",
    displayName: "svc",
    kind: "SERVICE",
    role: "SERVICE",
  });
  assert.ok(machine.ok);
  const serviceActor: IdentityActor = { id: machine.value.id, organizationId, role: "SERVICE" };
  const serviceRead = await h.spine.policies(serviceActor);
  assert.equal(serviceRead.ok, false);
});

/* -------------------------------------------------------------------------- */
/*  The console page                                                          */
/* -------------------------------------------------------------------------- */

function get(path: string, cookie?: string): HttpRequest {
  return {
    method: "GET",
    url: `https://id.sentinel.test${path}`,
    headers: {},
    cookies: cookie ? { [CONSOLE_SESSION_COOKIE]: cookie } : {},
  };
}

function post(path: string, body: string, cookie?: string): HttpRequest {
  return {
    method: "POST",
    url: `https://id.sentinel.test${path}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    cookies: cookie ? { [CONSOLE_SESSION_COOKIE]: cookie } : {},
    body,
  };
}

test("console: the policies page shows every scope, and a POST saves one", async () => {
  const h = harness();
  const { sessionId } = await organization(h, "page");

  const page = await routeConsole(get(CONSOLE_PATHS.policies, sessionId), h.service);
  assert.equal(page.status, 200);
  for (const scope of ["Baseline — everybody", "Admins", "Agents", "Services", "Auditors"]) {
    assert.match(page.body, new RegExp(scope.replace(/—/g, "\\u2014")), `the ${scope} card is missing`);
  }
  // The first render is the built-in default, stated as such rather than as a blank form.
  assert.match(page.body, /Not set/);
  assert.match(page.body, new RegExp(String(DEFAULT_IDENTITY_POLICY.maxSessionSeconds)));

  const saved = await routeConsole(
    post(CONSOLE_PATHS.policies, "scope=ALL&maxSessionSeconds=7200&idleTimeoutSeconds=900", sessionId),
    h.service,
  );
  assert.equal(saved.status, 303);
  assert.match(saved.headers.location, /policy/);

  const after = await routeConsole(get(CONSOLE_PATHS.policies, sessionId), h.service);
  assert.match(after.body, /Stored here/);
  assert.match(after.body, /value="7200"/);
  // `requireMfa` was absent from the body, so it is off — an unchecked checkbox sends
  // nothing, and reading that as "on" would make turning MFA *off* impossible.
  assert.doesNotMatch(after.body, new RegExp(`<input type="checkbox" name="requireMfa" value="on" checked`));

  // A bad number is refused with the page's own sentence, not a silent clamp.
  const bad = await routeConsole(
    post(CONSOLE_PATHS.policies, "scope=AGENT&maxSessionSeconds=600&idleTimeoutSeconds=900", sessionId),
    h.service,
  );
  assert.equal(bad.status, 400);
  assert.match(bad.body, /could never fire/);
});

test("console: the policies page needs a session, and a non-admin cannot write", async () => {
  const h = harness();
  const { sessionId, actor, organizationId } = await organization(h, "guard");

  const anonymous = await routeConsole(get(CONSOLE_PATHS.policies), h.service);
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.location, CONSOLE_PATHS.signIn);

  // The auditor has no second factor, so the baseline has to allow a session without
  // one — said deliberately, through the product, rather than by patching a store.
  assert.ok((await h.spine.setPolicy(actor, "ALL", { requireMfa: false, maxSessionSeconds: 3600, idleTimeoutSeconds: 900 })).ok);

  const auditor = await addIdentity(h, organizationId, "auditor@guard.test", "AUDITOR", false);
  const auditorSession = await h.spine.issueSession(organizationId, auditor.id);
  assert.ok(auditorSession.ok, auditorSession.ok ? "" : auditorSession.error);

  const readable = await routeConsole(get(CONSOLE_PATHS.policies, auditorSession.value.id), h.service);
  assert.equal(readable.status, 200);

  const refused = await routeConsole(
    post(CONSOLE_PATHS.policies, "scope=ALL&maxSessionSeconds=3600&idleTimeoutSeconds=900", auditorSession.value.id),
    h.service,
  );
  assert.equal(refused.status, 403);
  assert.match(refused.body, /administer policies/);

  assert.equal((await routeConsole(get(CONSOLE_PATHS.policies, sessionId), h.service)).status, 200);
});
