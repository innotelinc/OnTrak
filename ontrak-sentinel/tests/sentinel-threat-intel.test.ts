/**
 * OnTrak Sentinel S3 tests: threat intelligence, from a feed row to an escalated alert.
 *
 * The other half of a SOC's question is "have we seen this before, and does anybody else think
 * it is bad?" — so each test takes one way answering it goes wrong:
 *
 *  - **An indicator matched as a substring.** A feed that says `vendor.example` would fire on
 *    `not-evil-vendor.example`, which is one alert per page view for the rest of the
 *    deployment's life.
 *  - **A list nobody pruned.** An address is reassigned and a two-year-old entry reports the
 *    innocent, so an expired indicator must not match however confident the feed was.
 *  - **A feed's word taken as a verdict.** "This address is on a list" is not a claim that
 *    anything happened; a match changes how an existing detection is *judged*, and says which
 *    indicator moved it.
 *  - **A hobby list waking somebody up.** Confidence is carried and there is a floor below
 *    which a match annotates rather than escalates — and a feed's own severity can raise what
 *    a rule fired at, never lower it.
 *  - **A feed that grows by its own size every hour.** The id is derived from the indicator,
 *    so a poll is an update, and the first-seen instant survives it.
 *  - **A row that will never match anything.** A feed line the classifier will not take is
 *    refused by name rather than stored looking like protection.
 *  - **A withdrawal nobody can review.** Removing an indicator is an audited decision, and the
 *    alerts it already escalated keep it on their record.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toAlertCreate, toAlertRecord, toAlertUpdate, type AlertRow } from "../src/lib/alert-store-prisma";
import type { HashFn } from "../src/lib/audit-chain";
import { CONSOLE_PATHS, CONSOLE_SESSION_COOKIE } from "../src/lib/console-rules";
import { routeConsole } from "../src/lib/console-http";
import { ConsoleService } from "../src/lib/console-service";
import { DetectionService, MemoryAlertStore } from "../src/lib/detection-service";
import { sha256Hex } from "../src/lib/hash";
import {
  IdentityService,
  MemoryIdentityStore,
  OrganizationAuditLog,
  type IdentityActor,
} from "../src/lib/identity-service";
import { MemoryMfaStore, MfaService } from "../src/lib/mfa-service";
import type { HttpRequest } from "../src/lib/oidc-http";
import {
  CONFIDENCE_FLOOR,
  INDICATOR_KINDS,
  canonicalValue,
  classifyIndicator,
  domainMatches,
  escalateSeverity,
  escalationReason,
  hostOfUrl,
  indicatorId,
  isActive,
  matchEvent,
  matchIndicators,
  matchSummary,
  maxSeverity,
  parseFeedLines,
  parseIndicator,
  type Indicator,
  type IndicatorMatch,
} from "../src/lib/threat-intel-rules";
import {
  MemoryIndicatorStore,
  ThreatIntelService,
  type ThreatIntelIds,
} from "../src/lib/threat-intel-service";
import {
  PrismaIndicatorStore,
  toStoredIndicator,
  type IndicatorPrismaClient,
  type IndicatorRow,
} from "../src/lib/threat-intel-store-prisma";
import type { ObservedEvent } from "../src/lib/telemetry-rules";

const sha256: HashFn = sha256Hex;
const AT = Date.parse("2026-10-27T09:00:00.000Z");

const SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
const MD5 = "44d88612fea8a8f36de82e1278abb02f";

function event(over: Partial<ObservedEvent> = {}): ObservedEvent {
  return {
    kind: "NETWORK",
    source: "NETFLOW",
    at: AT,
    sensor: "fw-1",
    sourceAddress: "203.0.113.7",
    sourcePort: 51234,
    destinationAddress: "10.0.0.5",
    destinationPort: 22,
    protocol: "tcp",
    direction: null,
    attributes: {},
    ...over,
  };
}

/** An indicator through the real parser, so a test's fixtures are what the product accepts. */
function indicator(value: string, over: Partial<Indicator> = {}): Indicator {
  const parsed = parseIndicator({ value, source: "test-feed" }, { at: AT });
  assert.ok(parsed.ok, parsed.ok ? "" : JSON.stringify(parsed.issues));
  return { ...parsed.indicator, ...over };
}

/* -------------------------------------------------------------------------- */
/*  Classifying and canonicalising                                            */
/* -------------------------------------------------------------------------- */

test("intel: a value is classified by shape, and prose is refused", () => {
  assert.equal(classifyIndicator("203.0.113.9"), "IPV4");
  assert.equal(classifyIndicator("2001:db8::1"), "IPV6");
  assert.equal(classifyIndicator("10.0.0.0/24"), "CIDR");
  assert.equal(classifyIndicator("bad.example"), "DOMAIN");
  assert.equal(classifyIndicator("*.bad.example"), "DOMAIN");
  assert.equal(classifyIndicator("https://evil.example/path"), "URL");
  assert.equal(classifyIndicator(MD5), "MD5");
  assert.equal(classifyIndicator(SHA1), "SHA1");
  assert.equal(classifyIndicator(SHA256), "SHA256");

  // Refusing is the point: an indicator that will never match anything reads as protection.
  for (const refused of ["", "   ", "localhost", "not a value at all", "203.0.113.999", "10.0.0.0/33", "deadbeef"]) {
    assert.equal(classifyIndicator(refused), null, `“${refused}” should not be watched`);
  }

  // A stated kind that disagrees with the value is refused rather than trusted: a feed that
  // labels an address as a domain has a bug, and re-labelling it would hide the bug.
  const wrong = parseIndicator({ value: "203.0.113.9", kind: "DOMAIN", source: "f" }, { at: AT });
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.issues[0].field, "kind");

  // Provenance is required and never defaulted: "which feed told us this?" is the first
  // question asked about a false positive.
  const sourceless = parseIndicator({ value: "203.0.113.9" }, { at: AT });
  assert.equal(sourceless.ok, false);
  if (!sourceless.ok) assert.equal(sourceless.issues[0].field, "source");
});

test("intel: the same indicator in two spellings is one id, so a poll updates rather than duplicates", () => {
  assert.equal(canonicalValue("DOMAIN", "BAD.Example."), "bad.example");
  assert.equal(canonicalValue("DOMAIN", "*.BAD.example"), "*.bad.example");
  // The scheme and host are case-insensitive; the path is not, and is left alone.
  assert.equal(canonicalValue("URL", "HTTPS://Evil.Example/PaTh"), "https://evil.example/PaTh");

  assert.equal(indicatorId("DOMAIN", "BAD.example"), indicatorId("DOMAIN", "bad.example."));
  assert.notEqual(indicatorId("DOMAIN", "bad.example"), indicatorId("IPV4", "203.0.113.9"));

  const first = indicator("BAD.Example", { source: "feed-a" });
  const second = indicator("bad.example", { source: "feed-b" });
  assert.equal(first.id, second.id, "two feeds naming one address are one row");
  // Stated rather than hidden: one row carries one `source`, and the feed that spoke last
  // owns it. A list would be more precise and would make "withdraw it for this feed" a
  // question with two answers.
  assert.equal(second.source, "feed-b");
});

/* -------------------------------------------------------------------------- */
/*  The line format                                                           */
/* -------------------------------------------------------------------------- */

test("intel: a text feed is read line by line, and a bad field is refused by line", () => {
  const text = [
    "# abuse-ch sync 2026-10-27",
    "",
    "203.0.113.9",
    "*.bad.example | 80",
    "44d88612fea8a8f36de82e1278abb02f | 90 | CRITICAL | 2027-01-01",
    "198.51.100.4 || HIGH",
    "still-bad.example | 300",
    "another.example | 70 | SEVERE",
    "yet-another.example | 70 | | not-a-date",
  ].join("\n");

  const { rows, issues } = parseFeedLines(text);
  assert.equal(rows.length, 4, "a comment, a blank line, a bad confidence, a bad severity and a bad date are not rows");
  assert.deepEqual(rows[0], { value: "203.0.113.9" });
  assert.deepEqual(rows[1], { value: "*.bad.example", confidence: 80 });
  assert.equal(rows[2].severity, "CRITICAL");
  // A bare date expires at the *end* of the day named: reading it as midnight at the start
  // would withdraw the indicator a day early.
  assert.equal(rows[2].expiresAt, Date.parse("2027-01-01T23:59:59.999Z"));
  // An empty field in the middle sets nothing rather than being read positionally — a
  // confidence is not a severity and the person did not mean to swap them.
  assert.deepEqual(rows[3], { value: "198.51.100.4", severity: "HIGH" });

  assert.equal(issues.length, 3);
  assert.deepEqual(issues.map((issue) => issue.line), [7, 8, 9]);
  assert.match(issues[0].reason, /not a confidence between 0 and 100/);
  assert.match(issues[1].reason, /not one of LOW, MEDIUM, HIGH, CRITICAL/);
  assert.match(issues[2].reason, /not a date/);

  // And the rows the format accepted go on to the classifier, which is the other half.
  const kept = parseIndicator({ ...rows[1], source: "abuse-ch" }, { at: AT });
  assert.ok(kept.ok);
  assert.equal(kept.indicator.wildcard, true);
});

/* -------------------------------------------------------------------------- */
/*  Matching and escalation                                                   */
/* -------------------------------------------------------------------------- */

test("intel: a domain matches one host exactly, and * means the domain and under it", () => {
  const exact = indicator("vendor.example");
  assert.equal(domainMatches("vendor.example", exact), true);
  assert.equal(domainMatches("VENDOR.example.", exact), true, "a trailing dot is the same name");
  assert.equal(domainMatches("not-evil-vendor.example", exact), false, "never a substring");
  assert.equal(domainMatches("mail.vendor.example", exact), false, "the feed did not say its subdomains");

  const wildcard = indicator("*.bad.example");
  assert.equal(wildcard.wildcard, true);
  assert.equal(domainMatches("bad.example", wildcard), true, "the domain itself is included");
  assert.equal(domainMatches("a.b.bad.example", wildcard), true);
  assert.equal(domainMatches("bad.example.evil.test", wildcard), false);

  // A URL's host, without the credentials and the port: a feed lists hosts, not
  // `user:pass@host:8443`.
  assert.equal(hostOfUrl("https://user:pw@bad.example:8443/a?b=1"), "bad.example");
  assert.equal(hostOfUrl("http://[2001:db8::1]:80/x"), "2001:db8::1");
  assert.equal(hostOfUrl("not a url"), null);
});

test("intel: an expired indicator never matches, whatever it says", () => {
  const live = indicator("203.0.113.7", { expiresAt: AT + 1 });
  const dead = indicator("203.0.113.7", { expiresAt: AT });

  assert.equal(isActive(live, AT), true);
  assert.equal(isActive(dead, AT), false, "the boundary is exclusive: expiring *at* an instant means gone");
  assert.ok(matchEvent(event(), live, AT));
  assert.equal(matchEvent(event(), dead, AT), null);
  // Expiry is enforced in the matcher rather than by a sweep, so there is no window in
  // which the sweep has not run yet.
  assert.equal(matchIndicators(event(), [dead], AT).length, 0);
  assert.equal(matchIndicators(event(), [dead, live], AT).length, 1);
});

test("intel: a match names the field it was seen on", () => {
  const source = matchEvent(event(), indicator("203.0.113.7"), AT);
  assert.ok(source);
  assert.equal(source.field, "sourceAddress");
  assert.equal(source.attribute, null);
  assert.equal(source.observable, "203.0.113.7");

  const destination = matchEvent(event(), indicator("10.0.0.5"), AT);
  assert.ok(destination);
  assert.equal(destination.field, "destinationAddress");

  const block = matchEvent(event(), indicator("10.0.0.0/24"), AT);
  assert.ok(block, "a CIDR indicator is range math, not string equality");

  // A DNS query log names the resolver in its fields, not in the five-tuple.
  const inAttribute = matchEvent(event({ attributes: { resolver: "203.0.113.9" } }), indicator("203.0.113.9"), AT);
  assert.ok(inAttribute);
  assert.equal(inAttribute.field, "attribute");
  assert.equal(inAttribute.attribute, "resolver");

  const url = matchEvent(
    event({ attributes: { url: "https://bad.example/loader.js" } }),
    indicator("*.bad.example"),
    AT,
  );
  assert.ok(url);
  assert.equal(url.attribute, "url");

  const hash = matchEvent(event({ attributes: { sha256: SHA256 } }), indicator(SHA256), AT);
  assert.ok(hash);
  assert.equal(hash.attribute, "sha256");

  // Most confident first, when two different indicators are about one event.
  const sorted = matchIndicators(
    event({ attributes: { resolver: "203.0.113.7" } }),
    [indicator("203.0.113.7", { confidence: 70 }), indicator("203.0.113.0/24", { confidence: 95 })],
    AT,
  );
  assert.equal(sorted.length, 2);
  assert.equal(sorted[0].indicator.confidence, 95);
  assert.equal(sorted[0].indicator.kind, "CIDR");

  // Two spellings of one value are one indicator, so they are one match however many
  // fields of the event they appear on.
  const twice = matchIndicators(event({ attributes: { resolver: "203.0.113.7" } }), [indicator("203.0.113.7")], AT);
  assert.equal(twice.length, 1);
  assert.equal(twice[0].field, "sourceAddress", "the five-tuple is the answer before the detail bag");
});

/** One match against the standard event, so an escalation test reads as a sentence. */
function matched(value: string, over: Partial<Indicator> = {}): IndicatorMatch {
  const match = matchEvent(event(), indicator(value, over), AT);
  assert.ok(match, `“${value}” should match the standard event`);
  return match;
}

test("intel: a low-confidence match annotates, and a feed's severity never lowers a rule's", () => {
  assert.equal(matched("203.0.113.7", { confidence: CONFIDENCE_FLOOR - 1 }).escalates, false);
  assert.equal(matched("203.0.113.7", { confidence: CONFIDENCE_FLOOR }).escalates, true);

  // Above the floor and with no opinion of its own, a feed still says "somebody has already
  // met this address" — which is worth at least HIGH out of a LOW or a MEDIUM.
  assert.equal(escalateSeverity("LOW", [matched("203.0.113.7")]), "HIGH");
  assert.equal(escalateSeverity("MEDIUM", [matched("203.0.113.7")]), "HIGH");
  assert.equal(escalateSeverity("CRITICAL", [matched("203.0.113.7")]), "CRITICAL");

  // A feed's own severity is a floor: it can raise what a rule fired at, never lower it.
  assert.equal(escalateSeverity("LOW", [matched("203.0.113.7", { severity: "CRITICAL" })]), "CRITICAL");
  assert.equal(
    escalateSeverity("CRITICAL", [matched("203.0.113.7", { severity: "LOW" })]),
    "CRITICAL",
    "the rule saw the behaviour; the feed has only read about the address",
  );

  // Below the floor nothing moves at all, however loud the feed is.
  const weak = indicator("203.0.113.7", { confidence: 10, severity: "CRITICAL" });
  assert.equal(escalateSeverity("LOW", matchIndicators(event(), [weak], AT)), "LOW");
  assert.equal(escalateSeverity("MEDIUM", matchIndicators(event(), [weak], AT)), "MEDIUM");

  assert.equal(maxSeverity("MEDIUM", "HIGH"), "HIGH");
  assert.equal(maxSeverity("CRITICAL", "LOW"), "CRITICAL");

  // And the alert can say why, in a sentence, without recomputing anything.
  const reason = escalationReason([matched("203.0.113.7", { confidence: 95 })]);
  assert.ok(reason);
  assert.match(reason, /203\.0\.113\.7 matched an indicator from test-feed \(confidence 95\)/);
  assert.equal(escalationReason([]), null);
  assert.equal(escalationReason(matchIndicators(event(), [weak], AT)), null, "an annotation is not a reason");
  assert.equal(matchSummary([matched("203.0.113.7")]), "1 indicator(s) from test-feed");
  assert.equal(matchSummary([]), null);

  assert.equal(INDICATOR_KINDS.length, 8, "the vocabulary the console offers is the one this module can match");
});

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

let seq = 0;

function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const entities = new MemoryIdentityStore();
  let clock = AT;
  let n = 0;
  const tag = `i${++seq}`;
  const spine = new IdentityService(entities, audit, {
    id: () => `${tag}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  });
  const intelIds: ThreatIntelIds = {
    id: () => `${tag}-intel-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  const store = new MemoryIndicatorStore();
  const intel = new ThreatIntelService(store, audit, intelIds);
  const alerts = new MemoryAlertStore();
  const detection = new DetectionService(alerts, entities, audit, undefined, undefined, undefined, intel);
  const actor: IdentityActor = { id: "root", organizationId: "", role: "ADMIN" };

  return {
    spine,
    entities,
    audit,
    store,
    intel,
    alerts,
    detection,
    actor,
    advance: (ms: number) => {
      clock += ms;
    },
    async organization(slug: string) {
      const created = await spine.bootstrapOrganization("test", { name: `${slug} Inc`, slug }, { identifier: `admin@${slug}.test`, displayName: "Admin" });
      assert.ok(created.ok, created.ok ? "" : created.error);
      const admin: IdentityActor = { id: created.value.admin.id, organizationId: created.value.organization.id, role: "ADMIN" };
      actor.id = admin.id;
      actor.organizationId = admin.organizationId;
      return { admin, organizationId: admin.organizationId };
    },
  };
}

test("intel: ingesting a feed needs a policy administrator, and a refused row is reported not dropped", async () => {
  const h = harness();
  const { organizationId } = await h.organization("intel-ingest");
  const agent: IdentityActor = { id: h.actor.id, organizationId, role: "AGENT" };

  // The permission is the service's, asked once: a console page cannot widen it.
  const refused = await h.intel.ingest(agent, [{ value: "203.0.113.9", source: "abuse-ch" }]);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /policy administrator/);
  // Reading the list is a directory read — the people triaging need it — and changing what
  // the deployment watches is not.
  assert.equal((await h.intel.stats(agent)).ok, true);
  assert.equal((await h.intel.list(agent)).ok, true);

  const report = await h.intel.ingest(h.actor, [
    { value: "203.0.113.9", source: "abuse-ch", confidence: 90, severity: "HIGH", labels: ["c2"] },
    { value: "203.0.113.9", source: "abuse-ch" },
    { value: "*.bad.example", source: "abuse-ch", expiresAt: AT + 86_400_000 },
    { value: "not a value at all", source: "abuse-ch" },
    { value: "203.0.113.9" },
  ]);
  assert.ok(report.ok, report.ok ? "" : report.error);
  assert.equal(report.value.accepted, 2, "the second row of the same address was already known");
  assert.equal(report.value.updated, 1);
  assert.deepEqual(report.value.byFeed, { "abuse-ch": 3 });
  assert.equal(report.value.rejected.length, 2);
  assert.match(report.value.rejected[0].reason, /not a value this can watch/);
  assert.match(report.value.rejected[1].reason, /needs the feed it came from/);

  const stats = await h.intel.stats(h.actor);
  assert.ok(stats.ok, stats.ok ? "" : stats.error);
  assert.equal(stats.value.total, 2);
  assert.equal(stats.value.active, 2);
  assert.equal(stats.value.withExpiry, 1);
  assert.deepEqual(stats.value.byKind, { IPV4: 1, DOMAIN: 1 });
  assert.deepEqual(stats.value.byFeed, { "abuse-ch": 2 });

  const chain = h.audit.trail(organizationId).filter((entry) => entry.action === "guard.intel.ingested");
  assert.equal(chain.length, 1, "ingestion is not silent");
  assert.equal((chain[0].detail as { feeds: string[] }).feeds[0], "abuse-ch");
});

test("intel: a re-ingest refreshes a feed's own opinion and keeps how long we have watched it", async () => {
  const h = harness();
  const { organizationId } = await h.organization("intel-refresh");

  const first = await h.intel.ingest(h.actor, [{ value: "198.51.100.4", source: "feed-a", confidence: 80, labels: ["scanner"] }]);
  assert.ok(first.ok);
  assert.equal(first.value.accepted, 1);

  h.advance(3_600_000);
  const again = await h.intel.ingest(h.actor, [{ value: "198.51.100.4", source: "feed-a", confidence: 95 }]);
  assert.ok(again.ok);
  assert.equal(again.value.accepted, 0);
  assert.equal(again.value.updated, 1);

  const listed = await h.intel.list(h.actor);
  assert.ok(listed.ok, listed.ok ? "" : listed.error);
  assert.equal(listed.value.length, 1, "a feed polled hourly is not a table that grows hourly");
  assert.equal(listed.value[0].confidence, 95, "what a feed is entitled to change, changed");
  assert.equal(listed.value[0].firstSeenAt, AT, "how long we have watched it survived the poll");
  assert.deepEqual(listed.value[0].labels, [], "and a field the re-send omitted is not carried over as a stale one");
  assert.ok(h.audit.trail(organizationId).some((entry) => entry.action === "guard.intel.ingested"));
});

test("intel: withdrawing is an audited decision, and only where the indicator is", async () => {
  const h = harness();
  const { organizationId } = await h.organization("intel-withdraw");

  const ingested = await h.intel.ingest(h.actor, [
    { value: "203.0.113.9", source: "abuse-ch" },
    { value: "*.bad.example", source: "abuse-ch" },
  ]);
  assert.ok(ingested.ok);
  const listed = await h.intel.list(h.actor);
  assert.ok(listed.ok);
  const victim = listed.value.find((entry) => entry.value === "203.0.113.9");
  assert.ok(victim);

  const missing = await h.intel.withdraw(h.actor, "ipv4-nothing");
  assert.equal(missing.ok, false);

  const agent: IdentityActor = { id: h.actor.id, organizationId, role: "AGENT" };
  assert.equal((await h.intel.withdraw(agent, victim.id)).ok, false);

  const withdrawn = await h.intel.withdraw(h.actor, victim.id);
  assert.ok(withdrawn.ok, withdrawn.ok ? "" : withdrawn.error);
  assert.equal(withdrawn.value.source, "abuse-ch", "the chain keeps which feed it came from");
  const survivors = await h.intel.list(h.actor);
  assert.ok(survivors.ok);
  assert.equal(survivors.value.length, 1);

  const chain = h.audit.trail(organizationId).filter((entry) => entry.action === "guard.intel.withdrawn");
  assert.equal(chain.length, 1);
  const detail = chain[0].detail as { value: string; source: string; by: string };
  assert.equal(detail.value, "203.0.113.9", "the value is on the chain, not just the fact of a removal");
  assert.equal(detail.source, "abuse-ch");
  assert.equal(detail.by, h.actor.id);
});

test("intel: the detector is handed active indicators only", async () => {
  const h = harness();
  await h.organization("intel-active");

  await h.intel.ingest(h.actor, [
    { value: "203.0.113.9", source: "abuse-ch", expiresAt: AT + 1_000 },
    { value: "198.51.100.4", source: "abuse-ch" },
  ]);

  assert.equal((await h.intel.activeIndicators(h.actor.organizationId, AT)).length, 2);
  h.advance(2_000);
  const later = await h.intel.activeIndicators(h.actor.organizationId, AT + 2_000);
  assert.equal(later.length, 1, "the expired one is withheld where the list is read, in one place");
  assert.equal(later[0].value, "198.51.100.4");
});

/* -------------------------------------------------------------------------- */
/*  Detection, enriched                                                       */
/* -------------------------------------------------------------------------- */

const scanEvent = (at: number) => ({
  kind: "NETWORK",
  src_ip: "203.0.113.9",
  src_port: 40000 + (at % 1000),
  dst_ip: "10.0.0.5",
  dst_port: 445,
  direction: "LATERAL",
  timestamp: at,
});

test("guard: an indicator escalates a detection, and the alert keeps what it was judged on", async () => {
  const h = harness();
  const { organizationId } = await h.organization("intel-enrich");

  const ingested = await h.intel.ingest(h.actor, [
    { value: "203.0.113.9", source: "abuse-ch", confidence: 90, severity: "CRITICAL", labels: ["c2"] },
  ]);
  assert.ok(ingested.ok);

  const payloads = Array.from({ length: 20 }, (_, index) => scanEvent(AT + index * 100));
  const result = await h.detection.ingest(organizationId, "NETFLOW", payloads, { sensor: "fw-1" });
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.value.alerts.length, 1);

  const alerts = await h.detection.alerts(h.actor);
  assert.ok(alerts.ok, alerts.ok ? "" : alerts.error);
  const alert = alerts.value[0];
  assert.equal(alert.ruleId, "SG-BEH-001");
  assert.equal(alert.severity, "CRITICAL", "the rule fired at MEDIUM and the feed knew the address");

  assert.equal(alert.threatIntel.length, 1);
  const match = alert.threatIntel[0];
  assert.equal(match.field, "sourceAddress");
  assert.equal(match.observable, "203.0.113.9");
  assert.equal(match.escalates, true);
  assert.equal(match.indicator.source, "abuse-ch");
  assert.equal(match.indicator.confidence, 90);
  assert.equal(match.indicator.severity, "CRITICAL");
  assert.deepEqual(match.indicator.labels, ["c2"]);

  // The chain says what moved it, so "why is this CRITICAL?" is answered by the record.
  const raised = h.audit.trail(organizationId).filter((entry) => entry.action === "guard.alert.raised");
  assert.equal(raised.length, 1);
  const detail = raised[0].detail as { ruleSeverity: string; escalated: boolean; threatIntel: { source: string }[] };
  assert.equal(detail.ruleSeverity, "MEDIUM");
  assert.equal(detail.escalated, true);
  assert.equal(detail.threatIntel[0].source, "abuse-ch");
});

test("guard: enrichment that arrives after the alert still lands, and nothing walks the severity back", async () => {
  const h = harness();
  const { organizationId } = await h.organization("intel-late");
  const payloads = Array.from({ length: 20 }, (_, index) => scanEvent(AT + index * 100));

  // Nothing is watched yet, so this is the rule's own judgement.
  const first = await h.detection.ingest(organizationId, "NETFLOW", payloads, { sensor: "fw-1" });
  assert.ok(first.ok);
  assert.equal(first.value.alerts[0].created, true);
  const opened = await h.detection.alerts(h.actor);
  assert.ok(opened.ok, opened.ok ? "" : opened.error);
  assert.equal(opened.value[0].severity, "MEDIUM");
  assert.deepEqual(opened.value[0].threatIntel, []);

  // The feed catches up while the incident is open, and the other sensor reports the same
  // window again: the repeat unions the match and the alert gets louder, not duplicated.
  const fed = await h.intel.ingest(h.actor, [{ value: "203.0.113.9", source: "abuse-ch", severity: "CRITICAL" }]);
  assert.ok(fed.ok);
  const again = await h.detection.ingest(organizationId, "NETFLOW", payloads, { sensor: "fw-2" });
  assert.ok(again.ok);
  assert.equal(again.value.alerts[0].created, false);
  assert.equal(again.value.alerts[0].id, first.value.alerts[0].id);

  const reopened = await h.detection.alerts(h.actor);
  assert.ok(reopened.ok);
  const merged = reopened.value[0];
  assert.equal(merged.severity, "CRITICAL");
  assert.equal(merged.threatIntel.length, 1);
  assert.equal(merged.threatIntel[0].indicator.source, "abuse-ch");

  // Withdrawn, the escalation stays: the first burst is still part of the incident, and an
  // alert that quietly walked back from CRITICAL is one nobody can review.
  const withdrawn = await h.intel.withdraw(h.actor, merged.threatIntel[0].indicator.id);
  assert.ok(withdrawn.ok);
  const third = await h.detection.ingest(organizationId, "NETFLOW", payloads, { sensor: "fw-3" });
  assert.ok(third.ok);
  const settled = await h.detection.alerts(h.actor);
  assert.ok(settled.ok);
  const final = settled.value[0];
  assert.equal(final.severity, "CRITICAL");
  assert.equal(final.threatIntel.length, 1, "the match stays on the record it was used to judge");
  assert.equal(final.occurrences, 60);
});

test("guard: a deployment with no feed is not enriched, and pays nothing for it", async () => {
  const h = harness();
  const { organizationId } = await h.organization("intel-none");
  const bare = new DetectionService(h.alerts, h.entities, h.audit);
  const payloads = Array.from({ length: 20 }, (_, index) => scanEvent(AT + index * 100));

  const result = await bare.ingest(organizationId, "NETFLOW", payloads, { sensor: "fw-1" });
  assert.ok(result.ok);
  const alone = await bare.alerts(h.actor);
  assert.ok(alone.ok);
  assert.equal(alone.value[0].severity, "MEDIUM");
  assert.deepEqual(alone.value[0].threatIntel, []);
});

/* -------------------------------------------------------------------------- */
/*  The adapters                                                              */
/* -------------------------------------------------------------------------- */

function fakeIndicatorClient(): IndicatorPrismaClient & { rows: IndicatorRow[] } {
  const rows: IndicatorRow[] = [];
  const eq = (row: IndicatorRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, expected]) => (row as unknown as Record<string, unknown>)[key] === expected);

  return {
    rows,
    indicator: {
      async create(args: { data: unknown }) {
        const data = args.data as IndicatorRow;
        if (rows.some((row) => row.id === data.id && row.organizationId === data.organizationId)) {
          // The database's own behaviour, not a convenience: the composite key is what makes
          // a concurrent re-ingest an update rather than a lost write.
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        rows.push({ ...data });
        return data;
      },
      async findFirst(args: unknown) {
        const where = (args as { where: Record<string, unknown> }).where;
        const found = rows.find((row) => eq(row, where));
        return found ? { ...found } : null;
      },
      async findMany(args: unknown) {
        const where = (args as { where: Record<string, unknown> }).where;
        return rows.filter((row) => eq(row, where)).map((row) => ({ ...row }));
      },
      async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        const targets = rows.filter((row) => eq(row, args.where));
        for (const target of targets) Object.assign(target, args.data);
        return { count: targets.length };
      },
      async deleteMany(args: { where: Record<string, unknown> }) {
        const before = rows.length;
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (eq(rows[index], args.where)) rows.splice(index, 1);
        }
        return { count: before - rows.length };
      },
    },
  };
}

/** A raw row, as something other than this build might have written it. */
function rowFrom(
  record: Partial<IndicatorRow> & { id: string; kind: string; value: string; source: string },
): IndicatorRow {
  return {
    organizationId: "org-1",
    wildcard: false,
    confidence: 60,
    severity: null,
    labels: [],
    firstSeenAt: new Date(AT),
    expiresAt: null,
    createdAt: new Date(AT),
    updatedAt: new Date(AT),
    ...record,
  };
}

test("intel: the Prisma adapter inserts, refreshes and withdraws an indicator", async () => {
  const client = fakeIndicatorClient();
  const store = new PrismaIndicatorStore(client);

  const parsed = parseIndicator({ value: "*.bad.example", source: "abuse-ch", confidence: 80, labels: ["c2"] }, { at: AT });
  assert.ok(parsed.ok);
  const record = { ...parsed.indicator, organizationId: "org-1" };

  const created = await store.upsertIndicator(record);
  assert.equal(created.created, true);
  assert.equal(client.rows.length, 1);
  assert.equal(client.rows[0].kind, "DOMAIN");
  assert.equal(client.rows[0].wildcard, true);
  assert.deepEqual(client.rows[0].labels, ["c2"]);
  assert.equal(client.rows[0].expiresAt, null, "null is \"does not expire\", and it survives the round trip");

  // A re-send is an update, and the losing branch writes: that is the whole point of a feed.
  const later = { ...record, confidence: 95, expiresAt: AT + 1_000 };
  const refreshed = await store.upsertIndicator(later);
  assert.equal(refreshed.created, false);
  assert.equal(client.rows.length, 1);
  assert.equal(client.rows[0].confidence, 95);
  assert.equal(client.rows[0].firstSeenAt.getTime(), AT, "how long we have watched it survives the poll");

  const listed = await store.listIndicators("org-1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].value, "*.bad.example");
  assert.equal(listed[0].expiresAt, AT + 1_000);
  assert.equal((await store.listIndicators("org-2")).length, 0, "one tenant's feeds are not another's");

  // A row this build cannot express is left out of the matcher's list rather than guessed at.
  client.rows.push(rowFrom({ id: "magic-1", kind: "MAGIC", value: "something", source: "legacy" }));
  const afterJunk = await store.listIndicators("org-1");
  assert.equal(afterJunk.length, 1);
  assert.equal(toStoredIndicator(client.rows[1]), null);

  const found = await store.findIndicator("org-1", record.id);
  assert.ok(found);
  assert.equal(found.kind, "DOMAIN");
  assert.equal(await store.findIndicator("org-2", record.id), null);

  await store.deleteIndicator("org-1", record.id);
  assert.deepEqual(client.rows.map((row) => row.id), ["magic-1"], "only the named indicator went, out of the table");
  assert.deepEqual(await store.listIndicators("org-1"), [], "and the unreadable row is still not offered to the matcher");
});

function alertRow(over: Partial<AlertRow> = {}): AlertRow {
  return {
    id: "alert-1",
    organizationId: "org-1",
    ruleId: "SG-BEH-001",
    ruleVersion: 1,
    ruleName: "Repeated connections from one source to one port",
    severity: "CRITICAL",
    state: "NEW",
    dedupeKey: "SG-BEH-001@1|203.0.113.9|0",
    groupKey: "203.0.113.9",
    sourceAddress: "203.0.113.9",
    identityId: null,
    identityLabel: null,
    device: null,
    asset: null,
    firstSeenAt: new Date(AT),
    lastSeenAt: new Date(AT),
    occurrences: 20,
    evidence: [],
    threatIntel: [],
    note: null,
    assigneeId: null,
    assigneeLabel: null,
    assignedAt: null,
    createdAt: new Date(AT),
    updatedAt: new Date(AT),
    ...over,
  };
}

test("intel: an alert keeps its matches through the mapper, and a damaged one loses them", () => {
  const match = matchEvent(event({ sourceAddress: "203.0.113.9" }), indicator("203.0.113.9", { severity: "CRITICAL" }), AT);
  assert.ok(match);

  const record = toAlertRecord(alertRow({ threatIntel: [match] }));
  assert.equal(record.threatIntel.length, 1);
  assert.equal(record.threatIntel[0].indicator.severity, "CRITICAL");
  assert.equal(record.threatIntel[0].field, "sourceAddress");
  assert.equal(record.threatIntel[0].escalates, true);
  assert.equal(record.threatIntel[0].attribute, null);
  assert.equal(record.threatIntel[0].indicator.labels.length, 0);

  // The matches are what raised the severity, so a damaged entry is dropped rather than
  // repaired: a row written by a version that spoke a different shape must not make an alert
  // louder than the rule that fired.
  const damaged = toAlertRecord(
    alertRow({
      threatIntel: [
        match,
        { indicator: { id: "x" }, field: "nonsense", observable: "1.2.3.4", escalates: true },
        { indicator: { ...match.indicator, kind: "MAGIC" }, field: "sourceAddress", observable: "1.2.3.4", escalates: true },
        "not a match at all",
      ],
    }),
  );
  assert.equal(damaged.threatIntel.length, 1);
  assert.equal(damaged.threatIntel[0].indicator.id, match.indicator.id);

  assert.deepEqual(toAlertRecord(alertRow({ threatIntel: "not a list" })).threatIntel, [], "a column nobody expected is an empty list");

  // And the writes carry it: an update that dropped the matches would make the row stop
  // explaining itself the first time it repeated.
  assert.equal((toAlertCreate(record).threatIntel as unknown[]).length, 1);
  assert.equal((toAlertUpdate(record).threatIntel as unknown[]).length, 1);
});

/* -------------------------------------------------------------------------- */
/*  The console                                                               */
/* -------------------------------------------------------------------------- */

let consoleSeq = 0;

function consoleHarness(options: { intel?: boolean } = {}) {
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  let clock = AT;
  let n = 0;
  const tag = `c${++consoleSeq}`;
  const spine = new IdentityService(identities, audit, {
    id: () => `${tag}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  });
  const mfa = new MfaService(new MemoryMfaStore(), spine, audit);
  const ids: ThreatIntelIds = { id: () => `${tag}-intel-${++n}`, now: () => new Date(clock).toISOString(), nowMs: () => clock };
  const intel = options.intel === false ? null : new ThreatIntelService(new MemoryIndicatorStore(), audit, ids);
  const service =
    intel === null
      ? new ConsoleService(spine, mfa)
      : new ConsoleService(spine, mfa, null, null, null, null, null, null, intel);
  const actor: IdentityActor = { id: "root", organizationId: "", role: "ADMIN" };

  return {
    spine,
    intel,
    service,
    actor,
    advance: (ms: number) => {
      clock += ms;
    },
    async organization(slug: string) {
      const created = await spine.bootstrapOrganization("test", { name: `${slug} Inc`, slug }, { identifier: `admin@${slug}.test`, displayName: "Admin" });
      assert.ok(created.ok, created.ok ? "" : created.error);
      const admin: IdentityActor = { id: created.value.admin.id, organizationId: created.value.organization.id, role: "ADMIN" };
      actor.id = admin.id;
      actor.organizationId = admin.organizationId;
      assert.ok((await spine.setMfaEnrolled(admin, admin.id, true)).ok);
      const session = await spine.issueSession(admin.organizationId, admin.id);
      assert.ok(session.ok, session.ok ? "" : session.error);
      return { actor: admin, sessionId: session.value.id };
    },
  };
}

function request(method: string, path: string, body?: string, sessionId?: string): HttpRequest {
  const headers: Record<string, string | undefined> = {};
  const cookies: Record<string, string> = {};
  if (sessionId) cookies[CONSOLE_SESSION_COOKIE] = sessionId;
  if (body) headers["content-type"] = "application/x-www-form-urlencoded";
  return { method, url: `https://id.sentinel.test${path}`, headers, body, cookies };
}

test("console: the feed page reads, a paste is answered in place, and a withdrawal redirects", async () => {
  const h = consoleHarness();
  const intel = h.intel;
  assert.ok(intel, "this harness wires a feed");
  const { actor, sessionId } = await h.organization("intel-console");

  const page = await routeConsole(request("GET", CONSOLE_PATHS.intel, undefined, sessionId), h.service);
  assert.equal(page.status, 200);
  assert.match(page.body, /Add indicators/);
  assert.match(page.body, /Threat intel/);
  assert.match(page.body, new RegExp(`confidence ${CONFIDENCE_FLOOR}`), "the page promises the matcher's floor, not its own");

  // A paste: two rows the classifier takes, one it does not, and a line the *format* refuses.
  const rows = encodeURIComponent(["203.0.113.9 | 90", "*.bad.example", "this is prose", "198.51.100.4 | 900"].join("\n"));
  const posted = await routeConsole(
    request("POST", CONSOLE_PATHS.intelIngest, `source=abuse-ch&rows=${rows}`, sessionId),
    h.service,
  );
  assert.equal(posted.status, 200, "the answer to a paste is the page, because the refusals are the answer");
  assert.match(posted.body, /2 new indicator\(s\), 0 refreshed/);
  assert.match(posted.body, /this is prose — value: “this is prose” is not a value this can watch/);
  assert.match(posted.body, /198\.51\.100\.4 \| 900 — line 4: “900” is not a confidence between 0 and 100/);
  assert.match(posted.body, /<code>203\.0\.113\.9<\/code>/, "and the accepted rows are on the list below");

  const listed = await intel.list(actor);
  assert.ok(listed.ok, listed.ok ? "" : listed.error);
  assert.equal(listed.value.length, 2);

  // Withdrawing is a state change, so it answers with a redirect and a flash naming the value.
  const victim = listed.value.find((entry) => entry.value === "203.0.113.9");
  assert.ok(victim);
  const withdrawn = await routeConsole(
    request("POST", CONSOLE_PATHS.intelWithdraw, `indicatorId=${encodeURIComponent(victim.id)}`, sessionId),
    h.service,
  );
  assert.equal(withdrawn.status, 303);
  assert.match(String(withdrawn.headers.location ?? ""), /^\/console\/intel\?flash=/);
  assert.match(decodeURIComponent(String(withdrawn.headers.location ?? "")), /Withdrew 203\.0\.113\.9 from abuse-ch/);
  const left = await intel.list(actor);
  assert.ok(left.ok);
  assert.equal(left.value.length, 1);

  // A blank feed name is one sentence, not one refusal per row — and it is refused before
  // anything is parsed, so nothing was written.
  const nameless = await routeConsole(
    request("POST", CONSOLE_PATHS.intelIngest, "source=&rows=203.0.113.9", sessionId),
    h.service,
  );
  assert.equal(nameless.status, 400);
  assert.match(nameless.body, /Name the feed these indicators came from/);
  const afterRefusal = await intel.list(actor);
  assert.ok(afterRefusal.ok);
  assert.equal(afterRefusal.value.length, 1);

  // And the page is still the session-gated one: no cookie, no list.
  const anonymous = await routeConsole(request("GET", CONSOLE_PATHS.intel), h.service);
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.location, CONSOLE_PATHS.signIn);

  // The verbs are the ones the routes declared, so a form post cannot be driven by a link.
  const wrongVerb = await routeConsole(request("GET", CONSOLE_PATHS.intelIngest, undefined, sessionId), h.service);
  assert.equal(wrongVerb.status, 405);
  assert.equal(wrongVerb.headers.allow, "POST");
});

test("console: a deployment with no feed says so instead of offering a box", async () => {
  const h = consoleHarness({ intel: false });
  const { sessionId } = await h.organization("intel-unconfigured");

  const page = await routeConsole(request("GET", CONSOLE_PATHS.intel, undefined, sessionId), h.service);
  assert.equal(page.status, 400);
  assert.match(page.body, /no threat intelligence feeds configured/);
});
