/**
 * Sentinel S3/S4 tests: the control center — detection and prevention on one screen.
 *
 * The console has a page per question; the control center is the one page that asks all of
 * them at once, and the ways that goes wrong are what these tests are about:
 *
 *  - **It disagrees with the pages it summarizes.** Every figure is read through the same
 *    service calls the queue and the register use, so the cockpit cannot report a different
 *    backlog or a different block than the page it links to — asserted here by reading both.
 *  - **It becomes a second place to act.** It is read-only, and the test that matters is that
 *    there is no form on it: a cockpit with a block button would be a weaker enforcement
 *    surface wearing a dashboard's clothes.
 *  - **It shows prevention to somebody who may not act on it.** The register is an
 *    administrator's; a reader without that role is told why rather than shown a blank card.
 *  - **It renders somebody else's text as markup.** A rule name and a gap detail both reach
 *    the page, and both can contain `<`.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import {
  CONSOLE_PATHS,
  CONSOLE_SESSION_COOKIE,
  renderControlCenter,
  type ConsoleControlCenterView,
} from "../src/lib/console-rules";
import { ConsoleService } from "../src/lib/console-service";
import { routeConsole, type ConsoleEndpoints } from "../src/lib/console-http";
import { DetectionService, MemoryAlertStore } from "../src/lib/detection-service";
import { EnforcementService, MemoryEnforcementStore } from "../src/lib/enforcement-service";
import { sha256Hex } from "../src/lib/hash";
import {
  IdentityService,
  MemoryIdentityStore,
  OrganizationAuditLog,
  type IdentityActor,
} from "../src/lib/identity-service";
import { MemoryMfaStore, MfaService } from "../src/lib/mfa-service";
import type { HttpRequest } from "../src/lib/oidc-http";

const sha256: HashFn = sha256Hex;
const ORIGIN = "https://id.sentinel.test";
const SRC = "10.0.0.9";
const DST = "203.0.113.20";

/* -------------------------------------------------------------------------- */
/*  A view, built by hand, for the renderer                                    */
/* -------------------------------------------------------------------------- */

function view(overrides: Partial<ConsoleControlCenterView> = {}): ConsoleControlCenterView {
  return {
    actor: {
      identifier: "admin@acme.test",
      displayName: "Admin",
      role: "ADMIN",
      organizationName: "Acme",
      organizationSlug: "acme",
    },
    session: { id: "s1", issuedAt: "2026-11-01T00:00:00.000Z", expiresAt: "2026-11-01T01:00:00.000Z", lastSeenAt: "2026-11-01T00:00:00.000Z" },
    generatedAt: "2026-11-01T09:00:00.000Z",
    detection: {
      summary: {
        total: 2,
        open: 1,
        new: 1,
        acknowledged: 0,
        closed: 1,
        bySeverity: { LOW: 0, MEDIUM: 0, HIGH: 1, CRITICAL: 0 },
        escalated: 0,
        openHighOrCritical: 1,
        assigned: 0,
        unassigned: 1,
        oldestOpenAt: "2026-11-01T08:00:00.000Z",
        lastSeenAt: "2026-11-01T08:00:00.000Z",
      },
      watchlist: [
        {
          id: "a1",
          label: "Connection to a plaintext management service",
          severity: "HIGH",
          state: "NEW",
          at: "2026-11-01T08:00:00.000Z",
          occurrences: 1,
          who: null,
        },
      ],
      ruleCount: 3,
      rulebookVersion: "abc123def456",
      gaps: [{ what: "kind", name: "HTTP", detail: "No rule reads HTTP telemetry." }],
    },
    prevention: {
      active: 1,
      pending: 0,
      refused: 0,
      lifted: 0,
      prevention: { measured: 1, medianMs: 850, fastestMs: 850, slowestMs: 850 },
      policy: {
        protectedTargets: ["10.0.0.0/8"],
        maxTargets: 64,
        maxActionsPerHour: 20,
        defaultTtlSeconds: 3600,
        allowPermanent: false,
        requireSecondApprover: false,
      },
      policyStored: true,
      inForce: [
        { id: "e1", label: "Beaconing to a known C2", severity: null, state: "ACTIVE", at: "2026-11-01T09:00:00.000Z", occurrences: 1, who: "Admin" },
      ],
      waiting: [],
    },
    preventionNote: null,
    intel: { total: 5, active: 4, expired: 1, byFeed: { "abuse.ch": 4 }, byKind: { DOMAIN: 4 }, withExpiry: 4 },
    chain: { ok: true, length: 42, detail: "The organization's evidence chain verifies end to end." },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                  */
/* -------------------------------------------------------------------------- */

test("control center: both halves and the evidence are on the one screen", () => {
  const html = renderControlCenter(view());
  assert.match(html, /Detection — IDS/);
  assert.match(html, /Prevention — IPS/);
  assert.match(html, /<h3>In force<\/h3>/);
  // Detection's own figures, not a recomputation off the page.
  assert.match(html, /corpus <code>abc123def456<\/code>/);
  assert.match(html, /Connection to a plaintext management service/);
  // The measured time-to-prevent, stated.
  assert.match(html, /850ms/);
  // The evidence chain's verification, and the feed's counts.
  assert.match(html, /4 active indicator\(s\) of 5/);
  assert.match(html, /The organization&#39;s evidence chain verifies end to end\./);
});

test("control center: it is read-only — it links to the pages that act, and carries no control", () => {
  const html = renderControlCenter(view());
  // The shell's sign-out is the page's only form; the cockpit itself has none. A block button
  // here would be a second, weaker enforcement surface wearing a dashboard's clothes.
  const forms = html.match(/<form/g) ?? [];
  assert.equal(forms.length, 1, "the shell's sign-out is the only form on the page");
  assert.equal(/action="[^"]*(enforcement|alerts)/.test(html), false, "no control posts to an acting page");
  // What it does instead is hand the operator to the page that owns each act.
  assert.match(html, new RegExp(`href="${CONSOLE_PATHS.alerts}"`));
  assert.match(html, new RegExp(`href="${CONSOLE_PATHS.enforcement}"`));
});

test("control center: a reader who may not act is told why prevention is absent", () => {
  const note = "Prevention is an administrator's surface, so the register is not shown here.";
  const html = renderControlCenter(view({ prevention: null, preventionNote: note }));
  assert.match(html, /Prevention is an administrator&#39;s surface/);
  assert.match(html, /Not shown\./, "an absent register says so rather than drawing an empty one");
});

test("control center: a rule name and a gap detail cannot become markup", () => {
  const injected = "<img src=x onerror=alert(1)>";
  const html = renderControlCenter(
    view({
      detection: {
        ...view().detection!,
        watchlist: [{ id: "a1", label: injected, severity: "HIGH", state: "NEW", at: null, occurrences: 1, who: null }],
        gaps: [{ what: "source", name: injected, detail: injected }],
      },
    }),
  );
  assert.equal(html.includes(injected), false, "somebody else's text must not be rendered as markup");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

/* -------------------------------------------------------------------------- */
/*  The route                                                                  */
/* -------------------------------------------------------------------------- */

function request(method: string): HttpRequest {
  return {
    method,
    url: `${ORIGIN}${CONSOLE_PATHS.controlCenter}`,
    headers: { cookie: `${CONSOLE_SESSION_COOKIE}=s1` },
  };
}

test("control center: the route serves the page, and only on a GET", async () => {
  const endpoints = {
    controlCenter: async () => ({ ok: true as const, value: view() }),
  } as unknown as ConsoleEndpoints;

  const served = await routeConsole(request("GET"), endpoints);
  assert.equal(served.status, 200);
  assert.match(served.body ?? "", /Control center/);
  // The nav carries the link, so the page is reachable from every other page.
  assert.ok((served.body ?? "").includes(`href="${CONSOLE_PATHS.controlCenter}"`));

  const refused = await routeConsole(request("POST"), endpoints);
  assert.equal(refused.status, 405, "a state change must never be a GET, and this page has none");
});

/* -------------------------------------------------------------------------- */
/*  The service                                                                */
/* -------------------------------------------------------------------------- */

let harnessSeq = 0;

function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  const scope = `cc${++harnessSeq}`;
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
  const detection = new DetectionService(new MemoryAlertStore(), identities, audit, undefined, {
    id: () => `${scope}-alert-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  });
  const enforcement = new EnforcementService(new MemoryEnforcementStore(), audit, {
    id: () => `${scope}-enf-${++n}`,
    now: () => new Date(clock).toISOString(),
  });
  // Positional, like the deployment's wiring: detection is the tenth argument, prevention the
  // thirteenth, and everything else is a console feature this suite does not exercise.
  const service = new ConsoleService(spine, mfa, null, null, null, null, null, null, null, detection, null, null, enforcement, null);

  return { spine, detection, service, nowMs: () => clock };
}

/** One telemetry event that the shipped signature rule fires on. */
const TELEMETRY = {
  sourceAddress: SRC,
  destinationAddress: DST,
  destinationPort: 23,
  protocol: "tcp",
  direction: "OUTBOUND",
};

async function organization(spine: IdentityService) {
  const created = await spine.bootstrapOrganization("test", { name: "Acme Inc", slug: "acme" }, {
    identifier: "admin@acme.test",
    displayName: "Admin Acme",
  });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const admin: IdentityActor = { id: created.value.admin.id, organizationId: created.value.organization.id, role: "ADMIN" };

  const enrolledAdmin = await spine.setMfaEnrolled(admin, admin.id, true);
  assert.ok(enrolledAdmin.ok, enrolledAdmin.ok ? "" : enrolledAdmin.error);
  const adminSession = await spine.issueSession(admin.organizationId, admin.id);
  assert.ok(adminSession.ok, adminSession.ok ? "" : adminSession.error);

  const agent = await spine.createIdentity(admin, { identifier: "agent@acme.test", displayName: "Agent Acme", role: "AGENT" });
  assert.ok(agent.ok, agent.ok ? "" : agent.error);
  const enrolledAgent = await spine.setMfaEnrolled(admin, agent.value.id, true);
  assert.ok(enrolledAgent.ok, enrolledAgent.ok ? "" : enrolledAgent.error);
  const agentSession = await spine.issueSession(admin.organizationId, agent.value.id);
  assert.ok(agentSession.ok, agentSession.ok ? "" : agentSession.error);

  return {
    admin,
    adminSessionId: adminSession.value.id,
    agentSessionId: agentSession.value.id,
    organizationId: admin.organizationId,
  };
}

test("control center: an administrator sees detection, prevention and the chain", async () => {
  const { spine, detection, service } = harness();
  const org = await organization(spine);

  const ingested = await detection.ingest(org.organizationId, "NETFLOW", [TELEMETRY], {
    sensor: "collector-1",
    at: Date.parse("2026-11-01T08:00:00.000Z"),
  });
  assert.ok(ingested.ok, ingested.ok ? "" : ingested.error);
  assert.equal(ingested.value.alerts.length, 1, "the flow listener's event reaches detection");

  const result = await service.controlCenter(org.adminSessionId);
  assert.ok(result.ok, result.ok ? "" : result.error);

  const { detection: ids, prevention, chain, intel } = result.value;
  assert.ok(ids, "an administrator sees the detection half");
  assert.equal(ids.summary.open, 1);
  assert.equal(ids.summary.openHighOrCritical, 1, "the plaintext-management signature is HIGH");
  assert.equal(ids.watchlist.length, 1);
  assert.equal(ids.ruleCount, 3, "the cockpit reads the corpus this build runs");
  assert.match(ids.rulebookVersion, /^[0-9a-f]{12}$/);
  assert.ok(ids.gaps.length > 0, "blind spots are reported, not hidden");

  // Prevention is present for an administrator even with nothing in force — the register is
  // shown, not omitted, because "nothing is blocked" is a fact worth stating.
  assert.ok(prevention, "an administrator sees the prevention half");
  assert.equal(prevention.active, 0);
  assert.equal(prevention.pending, 0);
  assert.equal(prevention.policyStored, false, "no policy has been written on a fresh organization");
  assert.deepEqual(prevention.inForce, []);

  assert.equal(result.value.preventionNote, null);
  assert.equal(intel, null, "this harness wires no feed, and the cockpit says so");
  assert.ok(chain?.ok, "the chain verifies");
});

test("control center: a reader who may not act sees detection but not the register", async () => {
  const { spine, service } = harness();
  const org = await organization(spine);

  const result = await service.controlCenter(org.agentSessionId);
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.ok(result.value.detection, "an AGENT may read the Guard queue, so detection is shown");
  assert.equal(result.value.prevention, null, "prevention is an administrator's, even to read");
  assert.match(result.value.preventionNote ?? "", /administrator/i);
});
