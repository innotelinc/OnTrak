/**
 * OnTrak Sentinel S4 tests: the queue an operator actually works.
 *
 * Detection already answers *is this an incident* and *who is it about*. What it never had
 * was anybody to tell. These tests follow the three questions the page exists to answer,
 * because each one has a way of being answered wrongly that reads as a working screen:
 *
 *  - **What is still waiting on me?** A queue whose order disagreed with its own summary, or
 *    which aged an alert by when it was *first* seen, sends an operator to yesterday's
 *    incident instead of the one still arriving.
 *  - **What is this part of?** A neighbour list that padded itself with resolved alerts turns
 *    an investigation into a filtered list.
 *  - **Why is it this loud?** A severity explained from a live feed lookup goes blank the
 *    month the feed is withdrawn, which is exactly when somebody reviews it.
 *
 * And around the page: a console that renders for anybody, a state change reachable by GET, a
 * close with nothing on the record to justify it, and a posture report that asserts a control
 * is satisfied without reading the control.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import {
  ALERT_SEVERITIES,
  alertTimeline,
  annotationSummary,
  escalationSummary,
  filterAlerts,
  filterFrom,
  filterQuery,
  noFilter,
  relatedAlerts,
  triageActions,
  triageSummary,
  waitingMinutes,
} from "../src/lib/alert-triage-rules";
import { CONSOLE_PATHS, CONSOLE_SESSION_COOKIE } from "../src/lib/console-rules";
import { routeConsole } from "../src/lib/console-http";
import { ConsoleService } from "../src/lib/console-service";
import { DETECTION_RULES } from "../src/lib/detection-rules";
import { DetectionService, MemoryAlertStore, type AlertRecord } from "../src/lib/detection-service";
import { sha256Hex } from "../src/lib/hash";
import {
  IdentityService,
  MemoryIdentityStore,
  OrganizationAuditLog,
} from "../src/lib/identity-service";
import { MemoryMfaStore, MfaService } from "../src/lib/mfa-service";
import type { HttpRequest } from "../src/lib/oidc-http";
import type { ObservedEvent } from "../src/lib/telemetry-rules";
import type { IndicatorMatch } from "../src/lib/threat-intel-rules";

const sha256: HashFn = sha256Hex;
const ORIGIN = "https://id.sentinel.test";
const AT = Date.parse("2026-10-28T09:00:00.000Z");
const AT_ISO = new Date(AT).toISOString();

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

function event(over: Partial<ObservedEvent> = {}): ObservedEvent {
  return {
    kind: "NETWORK",
    source: "NETFLOW",
    at: AT,
    sensor: "fw-1",
    sourceAddress: "203.0.113.7",
    sourcePort: 51234,
    destinationAddress: "10.0.0.5",
    destinationPort: 23,
    protocol: "tcp",
    direction: "OUTBOUND",
    attributes: {},
    ...over,
  };
}

function match(over: Partial<IndicatorMatch["indicator"]> = {}, escalates = true): IndicatorMatch {
  return {
    indicator: {
      id: "ind-1",
      kind: "IPV4",
      value: "203.0.113.7",
      wildcard: false,
      source: "abuse-ch",
      confidence: 90,
      severity: "CRITICAL",
      labels: [],
      expiresAt: null,
      firstSeenAt: AT,
      ...over,
    },
    field: "sourceAddress",
    attribute: null,
    observable: "203.0.113.7",
    escalates,
  };
}

function alert(over: Partial<AlertRecord> = {}): AlertRecord {
  return {
    id: "alert-1",
    organizationId: "org-1",
    ruleId: "SG-SIG-001",
    ruleVersion: 1,
    ruleName: "Connection to a plaintext management service",
    severity: "HIGH",
    state: "NEW",
    dedupeKey: "k-1",
    groupKey: "203.0.113.7",
    sourceAddress: "203.0.113.7",
    identityId: "identity-1",
    identityLabel: "sam@acme.test",
    device: null,
    asset: "web-01",
    firstSeenAt: AT_ISO,
    lastSeenAt: AT_ISO,
    occurrences: 3,
    evidence: [event()],
    threatIntel: [],
    note: null,
    createdAt: AT_ISO,
    updatedAt: AT_ISO,
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/*  The queue                                                                 */
/* -------------------------------------------------------------------------- */

test("triage: the filter reads only values the rules define, and defaults rather than refusing", () => {
  const query = (value: string) => filterFrom(new URLSearchParams(value));

  assert.deepEqual(query(""), noFilter(), "an empty query is the default queue");
  assert.equal(query("state=new").state, "NEW", "a state is read case-insensitively");
  assert.equal(query("severity=critical").severity, "CRITICAL");
  assert.equal(query("state=NONSENSE").state, "OPEN", "an invented state falls back rather than matching nothing");
  assert.equal(query("severity=NONSENSE").severity, "ALL");
  assert.equal(query("identityId=%20%20").identityId, null, "whitespace is not a filter");
  assert.equal(query("address=203.0.113.7").address, "203.0.113.7");
  assert.equal(query("search=%20telnet%20").search, " telnet ", "the box is kept as typed; only the match trims");

  // And a filter round-trips through the query string it writes, which is what makes a
  // bookmarked queue the queue somebody was looking at.
  const filter = query("state=ACKNOWLEDGED&severity=HIGH&identityId=i1&address=203.0.113.7&search=scan");
  assert.deepEqual(filterFrom(new URLSearchParams(filterQuery(filter))), filter);
});

test("triage: the queue is open work by default, loudest first and stable between reads", () => {
  const alerts = [
    alert({ id: "low", severity: "LOW", lastSeenAt: new Date(AT - 60_000).toISOString() }),
    alert({ id: "critical-old", severity: "CRITICAL", lastSeenAt: new Date(AT - 600_000).toISOString() }),
    alert({ id: "critical-new", severity: "CRITICAL", lastSeenAt: AT_ISO }),
    alert({ id: "closed", state: "CLOSED", severity: "CRITICAL" }),
    alert({ id: "other-asset", severity: "MEDIUM", asset: "db-01", lastSeenAt: new Date(AT - 1_000).toISOString() }),
  ];

  const queue = filterAlerts(alerts, noFilter());
  assert.deepEqual(
    queue.map((entry) => entry.id),
    ["critical-new", "critical-old", "other-asset", "low"],
    "a closed alert is not waiting, and the loudest still-arriving one is first",
  );
  assert.deepEqual(
    filterAlerts(alerts, noFilter()).map((entry) => entry.id),
    queue.map((entry) => entry.id),
    "two reads of an unchanged queue must not reshuffle it",
  );

  assert.deepEqual(
    filterAlerts(alerts, { ...noFilter(), severity: "CRITICAL" }).map((entry) => entry.id),
    ["critical-new", "critical-old"],
  );
  assert.deepEqual(filterAlerts(alerts, { ...noFilter(), state: "ALL" }).length, 5);
  assert.deepEqual(
    filterAlerts(alerts, { ...noFilter(), state: "CLOSED" }).map((entry) => entry.id),
    ["closed"],
  );
  assert.deepEqual(
    filterAlerts(alerts, { ...noFilter(), search: "TELNET" }).length,
    0,
    "the search looks at the fields an operator names, not at the whole record",
  );
  assert.equal(filterAlerts(alerts, { ...noFilter(), address: "203.0.113.7" }).length, 4);
});

test("triage: the summary describes everything, and ages an alert by when it was last seen", () => {
  const alerts = [
    alert({ id: "a", severity: "HIGH", lastSeenAt: new Date(AT - 600_000).toISOString() }),
    alert({ id: "b", severity: "CRITICAL", state: "ACKNOWLEDGED", lastSeenAt: AT_ISO }),
    alert({ id: "c", severity: "LOW", state: "CLOSED" }),
    alert({ id: "d", severity: "MEDIUM", threatIntel: [match({}, false)] }),
  ];

  const summary = triageSummary(alerts);
  assert.equal(summary.total, 4);
  assert.equal(summary.open, 3);
  assert.equal(summary.new, 2);
  assert.equal(summary.acknowledged, 1);
  assert.equal(summary.closed, 1);
  assert.equal(summary.openHighOrCritical, 2);
  assert.equal(summary.escalated, 1, "an annotation is an indicator match too");
  assert.deepEqual(summary.bySeverity, { LOW: 1, MEDIUM: 1, HIGH: 1, CRITICAL: 1 });
  assert.equal(summary.oldestOpenAt, new Date(AT - 600_000).toISOString());

  // Age is measured from the last sighting: a burst still arriving is not an ignored alert.
  assert.equal(waitingMinutes(alerts[0], AT), 10);
  assert.equal(waitingMinutes(alerts[0], AT - 700_000), null, "a clock behind the alert has no age to report");
  assert.equal(waitingMinutes(alerts[2], AT), null, "a closed alert is not waiting on anybody");
});

/* -------------------------------------------------------------------------- */
/*  The investigation                                                         */
/* -------------------------------------------------------------------------- */

test("triage: neighbours are reasoned about and a resolved alert is never one of them", () => {
  const subject = alert({ id: "subject", identityId: "i-1", sourceAddress: "203.0.113.7", asset: "web-01" });
  const neighbours = [
    alert({ id: "same-person", identityId: "i-1", sourceAddress: "198.51.100.4", severity: "MEDIUM" }),
    alert({ id: "same-address", identityId: "i-2", sourceAddress: "203.0.113.7", asset: "fw-01" }),
    alert({ id: "same-asset", identityId: "i-3", sourceAddress: "198.51.100.9", asset: "web-01" }),
    alert({ id: "group-only", identityId: "i-4", sourceAddress: "198.51.100.9", asset: "other", groupKey: "203.0.113.7" }),
    alert({ id: "unrelated", identityId: "i-5", sourceAddress: "198.51.100.1", asset: "other", groupKey: "g", severity: "LOW" }),
    alert({ id: "resolved", identityId: "i-1", state: "CLOSED" }),
  ];

  const related = relatedAlerts([subject, ...neighbours], subject);
  assert.deepEqual(
    related.map((entry) => entry.id),
    ["same-person", "same-address", "same-asset", "group-only"],
    "tightest relation first, and a closed alert is nobody's neighbour",
  );
  assert.equal(related[0].kind, "identity");
  assert.equal(related[0].shared, "sam@acme.test", "the shared value is named, not described as \"an identity\"");
  assert.equal(related[1].kind, "address");
  assert.equal(related[3].kind, "group", "an alert that relates on nothing else is still reported by its group");

  // The limit is honoured, because an investigation with a thousand neighbours is not one.
  const many = Array.from({ length: 40 }, (_, index) => alert({ id: `n-${index}`, identityId: "i-1" }));
  assert.equal(relatedAlerts([subject, ...many], subject, 5).length, 5);
});

test("triage: the timeline reads the record, and the escalation survives a withdrawn feed", () => {
  const subject = alert({
    id: "subject",
    severity: "CRITICAL",
    threatIntel: [match({ id: "bad", value: "203.0.113.7" }, true), match({ id: "meh", value: "*.bad.example", kind: "DOMAIN", confidence: 40 }, false)],
    note: "Watching it",
    state: "ACKNOWLEDGED",
  });

  const escalation = escalationSummary(subject);
  assert.match(escalation ?? "", /CRITICAL because/);
  assert.match(escalation ?? "", /203\.0\.113\.7/);
  assert.match(escalation ?? "", /confidence 90/, "the confidence it was judged on is on the record, not looked up again");
  assert.doesNotMatch(escalation ?? "", /bad\.example/, "an annotation is not an escalation");

  assert.match(annotationSummary(subject) ?? "", /below the confidence floor/);
  assert.equal(escalationSummary(alert({ severity: "CRITICAL" })), null, "a rule that fires at CRITICAL needs no explanation");

  const timeline = alertTimeline(subject);
  assert.equal(timeline[0].kind, "observed");
  assert.equal(timeline[0].title, `First seen by ${subject.ruleName}`);
  assert.ok(
    timeline.some((entry) => entry.kind === "evidence" && entry.detail.includes("203.0.113.7:51234 → 10.0.0.5:23 tcp OUTBOUND")),
    "the evidence line names the ports and the direction a person would draw on a whiteboard",
  );
  assert.ok(timeline.some((entry) => entry.kind === "indicator" && entry.title.startsWith("Escalated by")));
  assert.ok(timeline.some((entry) => entry.kind === "note" && entry.detail === "Watching it"));
  const instants = timeline.map((entry) => entry.at);
  assert.deepEqual([...instants].sort((a, b) => a.localeCompare(b)), instants, "the timeline reads oldest first");

  assert.deepEqual(triageActions(alert({ state: "NEW" })), { canAcknowledge: true, canClose: true });
  assert.deepEqual(triageActions(alert({ state: "ACKNOWLEDGED" })), { canAcknowledge: false, canClose: true });
  assert.deepEqual(
    triageActions(alert({ state: "CLOSED" })),
    { canAcknowledge: false, canClose: false },
    "a closed alert offers no action that would take it out of the state it is in",
  );
});

/* -------------------------------------------------------------------------- */
/*  The console surface                                                       */
/* -------------------------------------------------------------------------- */

let harnessSeq = 0;

function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  const store = new MemoryAlertStore();
  const scope = `t${++harnessSeq}`;
  let clock = AT;
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
  const detection = new DetectionService(
    store,
    identities,
    audit,
    DETECTION_RULES,
    { id: () => `${scope}-alert-${++n}`, now: () => new Date(clock).toISOString(), nowMs: () => clock },
    sha256,
  );
  // Positional, like the deployment's own wiring: the detection pipeline is the tenth
  // collaborator, and everything between it and the second argument is a console feature
  // this suite is not exercising.
  const service = new ConsoleService(spine, mfa, null, null, null, null, null, null, null, detection);

  return {
    spine,
    store,
    detection,
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
      const actor = {
        id: created.value.admin.id,
        organizationId: created.value.organization.id,
        role: "ADMIN" as const,
      };
      // The flag without a factor, the shortcut the other console suites use: the default
      // policy requires a second factor, so without one this administrator could not hold the
      // session these tests need, and the *factor* is not what is under test here.
      const enrolled = await spine.setMfaEnrolled(actor, actor.id, true);
      assert.ok(enrolled.ok, enrolled.ok ? "" : enrolled.error);

      const session = await spine.issueSession(actor.organizationId, actor.id);
      assert.ok(session.ok, session.ok ? "" : session.error);
      return { actor, sessionId: session.value.id };
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

test("alerts: the queue is behind a session, and a deployment without detection says so", async () => {
  const h = harness();
  const { sessionId } = await h.organization("acme");

  const anonymous = await routeConsole(request("GET", CONSOLE_PATHS.alerts), h.service);
  assert.equal(anonymous.status, 401, "a queue of incidents is not a public page");
  assert.equal(anonymous.headers["cache-control"], "no-store");

  // A deployment that ingests no telemetry has no queue, and says so rather than showing an
  // empty one — an empty queue and an unwired pipeline are different claims.
  const bare = new ConsoleService(h.spine, new MfaService(new MemoryMfaStore(), h.spine));
  const refused = await routeConsole(request("GET", CONSOLE_PATHS.alerts, { sessionId }), bare);
  assert.equal(refused.status, 400);
  assert.match(refused.body, /runs no detection pipeline/);

  // A state change cannot be smuggled in as a read: the two POST paths do not answer GET.
  const wrongVerb = await routeConsole(request("GET", CONSOLE_PATHS.alertClose, { sessionId }), h.service);
  assert.equal(wrongVerb.status, 405);
  assert.equal(wrongVerb.headers.allow, "POST");
});

test("alerts: the queue renders what detection raised, and one alert can be opened", async () => {
  const h = harness();
  const { actor, sessionId } = await h.organization("acme");
  const recorded = await h.detection.record(actor.organizationId, [event()]);
  assert.equal(recorded.alerts.length, 1, "telnet outbound is what the signature rule names");
  const alertId = recorded.alerts[0].id;
  // The same connection a second time: a repeat refreshes the alert somebody is working
  // rather than raising a second one — the reason this queue is a queue and not a log.
  const again = await h.detection.record(actor.organizationId, [event()]);
  assert.equal(again.alerts[0].created, false);
  assert.equal(again.alerts[0].id, alertId);

  const page = await routeConsole(request("GET", CONSOLE_PATHS.alerts, { sessionId }), h.service);
  assert.equal(page.status, 200);
  assert.match(page.body, /Connection to a plaintext management service/);
  assert.match(page.body, /class="sev sev-high">HIGH</);
  assert.match(page.body, new RegExp(CONSOLE_PATHS.alerts), "the nav reaches the queue from the queue");
  assert.match(page.body, new RegExp(CONSOLE_PATHS.compliance), "and the posture page is reachable too");

  const opened = await routeConsole(
    request("GET", `${CONSOLE_PATHS.alerts}?alert=${encodeURIComponent(alertId)}`, { sessionId }),
    h.service,
  );
  assert.equal(opened.status, 200);
  assert.match(opened.body, /Investigating/);
  assert.match(opened.body, /What else is this/);
  assert.match(opened.body, /What happened/);
  assert.match(opened.body, /Why it is finished/, "the close form asks for the reason it requires");

  const missing = await routeConsole(request("GET", `${CONSOLE_PATHS.alerts}?alert=nope`, { sessionId }), h.service);
  assert.equal(missing.status, 400);
  assert.match(missing.body, /does not exist/);
});

test("alerts: acknowledging and closing are POSTs, audited, and a close without a reason is refused", async () => {
  const h = harness();
  const { actor, sessionId } = await h.organization("acme");
  const recorded = await h.detection.record(actor.organizationId, [event()]);
  const alertId = recorded.alerts[0].id;

  const unknown = await routeConsole(request("POST", CONSOLE_PATHS.alertAcknowledge, { sessionId, body: "" }), h.service);
  assert.equal(unknown.status, 400);

  const acknowledged = await routeConsole(
    request("POST", CONSOLE_PATHS.alertAcknowledge, { sessionId, body: `alertId=${alertId}&note=Looking+at+it` }),
    h.service,
  );
  assert.equal(acknowledged.status, 303, "a state change answers with a redirect, so a refresh does not repeat it");
  assert.match(acknowledged.headers.location ?? "", new RegExp(`alert=${alertId}`), "and comes back to the alert, not the top of the queue");
  const afterAck = await h.store.findAlert(actor.organizationId, alertId);
  assert.equal(afterAck?.state, "ACKNOWLEDGED");
  assert.equal(afterAck?.note, "Looking at it");

  const noReason = await routeConsole(
    request("POST", CONSOLE_PATHS.alertClose, { sessionId, body: `alertId=${alertId}&note=ok` }),
    h.service,
  );
  assert.equal(noReason.status, 400, "the reason's minimum length is the service's rule, asked once");
  assert.equal((await h.store.findAlert(actor.organizationId, alertId))?.state, "ACKNOWLEDGED");

  const closed = await routeConsole(
    request("POST", CONSOLE_PATHS.alertClose, {
      sessionId,
      body: `alertId=${alertId}&note=Blocked+at+the+edge`,
    }),
    h.service,
  );
  assert.equal(closed.status, 303);
  assert.equal((await h.store.findAlert(actor.organizationId, alertId))?.state, "CLOSED");

  // Both transitions are on the evidence chain, against the person who made them.
  const trail = await h.spine.auditTrail(actor);
  assert.ok(trail.ok, trail.ok ? "" : trail.error);
  const actions = trail.value.events.map((entry) => entry.action);
  assert.ok(actions.includes("guard.alert.acknowledged"));
  assert.ok(actions.includes("guard.alert.closed"));
  assert.equal(actions.filter((action) => action.startsWith("guard.alert.")).length, 3, "raised, acknowledged, closed");

  // And a closed alert stops offering the work it no longer has.
  const reopened = await routeConsole(
    request("GET", `${CONSOLE_PATHS.alerts}?state=CLOSED&alert=${alertId}`, { sessionId }),
    h.service,
  );
  assert.equal(reopened.status, 200);
  assert.match(reopened.body, /nothing left to do to it/);
});

test("compliance: the report reads the controls rather than asserting them", async () => {
  const h = harness();
  const { actor, sessionId } = await h.organization("acme");

  // One person with a factor, one without, and a service identity: the three cases a
  // coverage number has to tell apart.
  const agent = await h.spine.createIdentity(actor, { identifier: "sam@acme.test", displayName: "Sam", role: "AGENT" });
  assert.ok(agent.ok, agent.ok ? "" : agent.error);
  const robot = await h.spine.createIdentity(actor, { identifier: "sync", displayName: "Sync", kind: "SERVICE", role: "SERVICE" });
  assert.ok(robot.ok, robot.ok ? "" : robot.error);

  await h.detection.record(actor.organizationId, [event()]);

  const page = await routeConsole(request("GET", CONSOLE_PATHS.compliance, { sessionId }), h.service);
  assert.equal(page.status, 200);
  assert.match(page.body, /Controls in force/);
  assert.match(page.body, /evidence chain verifies end to end/);
  assert.match(page.body, /class="control-ok">OK</);

  // The population is counted, and a person without a factor is a warning rather than a tick.
  assert.match(page.body, /3 identities/);
  assert.match(page.body, /1 have a second factor on record/);
  assert.match(page.body, /class="control-warn">WARN</);

  // A baseline no administrator has ever written is reported as not stored, because the
  // number the login path uses is the code's default rather than a decision on the record.
  assert.match(page.body, /built-in default/);

  // Writing one changes the report, which is the only way to know the report is a reading.
  const saved = await h.spine.setPolicy(actor, "ALL", { requireMfa: false, maxSessionSeconds: 3600, idleTimeoutSeconds: 600 });
  assert.ok(saved.ok, saved.ok ? "" : saved.error);
  const after = await routeConsole(request("GET", CONSOLE_PATHS.compliance, { sessionId }), h.service);
  assert.equal(after.status, 200);
  assert.match(after.body, /The baseline is stored/);
  assert.match(after.body, /Not required for Baseline/);
  assert.match(after.body, /the baseline has one/, "the population card stops reporting a default nobody wrote");
  assert.doesNotMatch(after.body, /resolves to the built-in default/);

  const anonymous = await routeConsole(request("GET", CONSOLE_PATHS.compliance), h.service);
  assert.equal(anonymous.status, 401);
});
