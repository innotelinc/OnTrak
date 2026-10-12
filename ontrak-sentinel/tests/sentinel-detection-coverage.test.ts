/**
 * OnTrak Sentinel S3 tests: the detection-coverage map.
 *
 * A coverage map is the one report in a detection platform that is only useful if it is
 * allowed to be disappointing. The three ways it stops being that, and what these tests
 * hold it to:
 *
 *  - **It reports coverage that is not there.** A map built from a source list rather than
 *    from the rules would show every declared source as watched, which is the opposite of
 *    what a reader needs. The report is derived from `DETECTION_RULES`, so a deliberately
 *    narrow rulebook has to show its blind spots, and the shipped rulebook — which now has a
 *    reader for every declared kind and source — has to show *none*, rather than inventing
 *    one to look busy.
 *  - **It reads the rulebook differently from the pipeline.** `appliesTo.kinds` and
 *    `appliesTo.sources` mean specific things to `ruleApplies`; a second reading here would
 *    drift, so the two override rules (a missing list means everything, an explicit source
 *    list wins) are asserted directly.
 *  - **It counts a rule that can never fire.** A rule naming a kind or source this build has
 *    no vocabulary for would read no event; it is named rather than shown as coverage.
 *
 * And around the page: a map behind a session, and every value escaped.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CONSOLE_PATHS, CONSOLE_SESSION_COOKIE, renderCoverage, type ConsoleCoverageView } from "../src/lib/console-rules";
import { routeConsole } from "../src/lib/console-http";
import { ConsoleService } from "../src/lib/console-service";
import { DETECTION_RULES, type DetectionRule } from "../src/lib/detection-rules";
import {
  coverageReport,
  ruleReadsKind,
  ruleReadsSource,
} from "../src/lib/detection-coverage-rules";
import { sha256Hex } from "../src/lib/hash";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog } from "../src/lib/identity-service";
import { MemoryMfaStore, MfaService } from "../src/lib/mfa-service";
import type { HttpRequest } from "../src/lib/oidc-http";
import type { TelemetrySource } from "../src/lib/telemetry-rules";

const ORIGIN = "https://id.sentinel.test";

/** A rule that reads only what it names, so the two override rules can be read off it. */
function rule(overrides: Partial<DetectionRule>): DetectionRule {
  return {
    id: "SG-TEST-000",
    version: 1,
    name: "a rule",
    severity: "LOW",
    description: "a rule",
    references: [],
    appliesTo: {},
    detection: { kind: "signature", match: {} },
    ...overrides,
  };
}

test("coverage: the shipped rulebook reads every declared kind and source", () => {
  const report = coverageReport();

  // The rulebook is the input, so every shipped rule is on the map with its version.
  assert.deepEqual(
    report.rules.map((entry) => entry.id).sort(),
    [
      "SG-ANM-001", "SG-ANM-002", "SG-ANM-003",
      "SG-BEH-001", "SG-BEH-002", "SG-BEH-003", "SG-BEH-004",
      "SG-HOST-001", "SG-HOST-002", "SG-HOST-003", "SG-HTTP-001",
      "SG-SIG-001", "SG-SIG-002",
    ],
  );
  assert.equal(report.rules.every((entry) => entry.version >= 1), true);

  // Every kind has a reader now — the host and HTTP rules were the build's blind spots and are
  // no longer — and the map is allowed to say so rather than manufacturing a gap.
  const byKind = Object.fromEntries(report.kinds.map((entry) => [entry.kind, entry]));
  for (const kind of ["NETWORK", "HOST", "HTTP", "AUTH"] as const) {
    assert.equal(byKind[kind].covered, true, `${kind} should be read`);
    assert.ok(byKind[kind].rules.length > 0);
  }

  // By source, through the normalizer's own kind mapping: EBPF and EDR are HOST and PROXY is
  // HTTP, and the host/HTTP rules reach them the same way a firewall's flow is reached.
  const bySource = Object.fromEntries(report.sources.map((entry) => [entry.source, entry]));
  assert.equal(bySource.NETFLOW.kind, "NETWORK");
  assert.equal(bySource.EBPF.kind, "HOST");
  assert.equal(bySource.EDR.kind, "HOST");
  assert.equal(bySource.PROXY.kind, "HTTP");
  for (const source of ["NETFLOW", "FIREWALL", "EBPF", "EDR", "PROXY"] as const) {
    assert.equal(bySource[source].covered, true, `${source} should be read`);
  }

  // Every kind is read, so there is no gap to report — and a map that listed one anyway would
  // be the failure this page exists to prevent.
  assert.deepEqual(report.gaps, []);
  assert.deepEqual(report.unreachable, []);

  // AUTH is never implied by a source — it is a kind a payload claims — so no source maps to
  // it even though a rule reads it.
  assert.equal(report.sources.some((entry) => entry.kind === "AUTH"), false);
});

test("coverage: a narrow rulebook's blind spots are still named", () => {
  // The map's honesty does not depend on the shipped rulebook covering everything: hand it a
  // narrow one and the gaps it names are the same question answered against that input.
  const networkOnly = rule({ id: "SG-NET", appliesTo: { kinds: ["NETWORK"] } });
  const report = coverageReport([networkOnly]);

  const byKind = Object.fromEntries(report.kinds.map((entry) => [entry.kind, entry]));
  assert.equal(byKind.NETWORK.covered, true);
  assert.equal(byKind.HOST.covered, false);
  assert.equal(byKind.HTTP.covered, false);

  const gapNames = report.gaps.map((gap) => gap.name);
  for (const name of ["HOST", "HTTP", "EBPF", "EDR", "PROXY"]) {
    assert.ok(gapNames.includes(name), `${name} is missing from the gap list`);
  }
  for (const gap of report.gaps) {
    assert.ok(gap.detail.length > 0, "a gap without an explanation is a bare accusation");
  }
});

test("coverage: the read rules match the pipeline's, both overrides included", () => {
  // A rule with neither list reads every kind and every source.
  const universal = rule({ id: "SG-ANY" });
  assert.equal(ruleReadsKind(universal, "HOST"), true);
  assert.equal(ruleReadsSource(universal, "PROXY"), true);
  const allCovered = coverageReport([universal]);
  assert.equal(allCovered.gaps.length, 0, "a rule that reads everything leaves no gap");

  // `kinds` narrows; a source whose kind is not read is not read.
  const networkOnly = rule({ id: "SG-NET", appliesTo: { kinds: ["NETWORK"] } });
  assert.equal(ruleReadsSource(networkOnly, "NETFLOW"), true);
  assert.equal(ruleReadsSource(networkOnly, "PROXY"), false);

  // An explicit `sources` list overrides the kind reading — that is what it is for, and a map
  // that ignored it would credit a rule with traffic it filters out.
  const oneSource = rule({ id: "SG-PROXY", appliesTo: { kinds: ["HTTP"], sources: ["PROXY"] } });
  assert.equal(ruleReadsSource(oneSource, "PROXY"), true);
  const rawSource = rule({ id: "SG-SYSLOG", appliesTo: { sources: ["SYSLOG"] } });
  assert.equal(ruleReadsSource(rawSource, "SYSLOG"), true);
  assert.equal(ruleReadsSource(rawSource, "NETFLOW"), false, "an explicit list is not widened by the kind");

  // And a source a rule names is read even when the kind would not have reached it.
  const surprising = rule({ id: "SG-MIX", appliesTo: { kinds: ["HOST"], sources: ["SYSLOG"] } });
  assert.equal(ruleReadsSource(surprising, "SYSLOG"), true);
});

test("coverage: a rule that names vocabulary this build does not have is not coverage", () => {
  const bogus = rule({ id: "SG-BOGUS", appliesTo: { kinds: ["TELEPATHY"], sources: ["VIBES"] } });
  const report = coverageReport([...DETECTION_RULES, bogus]);

  assert.equal(report.unreachable.length, 1);
  assert.equal(report.unreachable[0].id, "SG-BOGUS");
  assert.match(report.unreachable[0].detail, /TELEPATHY/);
  assert.match(report.unreachable[0].detail, /VIBES/);
  assert.equal(report.rules.some((entry) => entry.id === "SG-BOGUS"), true, "it is still listed as a rule");
});

test("coverage: the page is behind a session, and renders what the rulebook says", async () => {
  const spine = new IdentityService(new MemoryIdentityStore(), new OrganizationAuditLog(sha256Hex), {
    id: (() => {
      let n = 0;
      return () => `cov-id-${++n}`;
    })(),
    now: () => new Date("2026-10-30T09:00:00.000Z").toISOString(),
    nowMs: () => Date.parse("2026-10-30T09:00:00.000Z"),
  });
  const mfa = new MfaService(new MemoryMfaStore(), spine);
  const service = new ConsoleService(spine, mfa);

  const request = (sessionId?: string): HttpRequest => ({
    method: "GET",
    url: `${ORIGIN}${CONSOLE_PATHS.coverage}`,
    headers: {},
    cookies: sessionId ? { [CONSOLE_SESSION_COOKIE]: sessionId } : {},
  });

  const anonymous = await routeConsole(request(), service);
  assert.equal(anonymous.status, 303, "the map is not a public page");
  assert.equal(anonymous.headers.location, CONSOLE_PATHS.signIn);

  const created = await spine.bootstrapOrganization("test", { name: "Acme Inc", slug: "acme" }, {
    identifier: "admin@acme.test",
    displayName: "Admin Acme",
  });
  assert.ok(created.ok, created.ok ? "" : created.error);
  const actor = { id: created.value.admin.id, organizationId: created.value.organization.id, role: "ADMIN" as const };
  const enrolled = await spine.setMfaEnrolled(actor, actor.id, true);
  assert.ok(enrolled.ok, enrolled.ok ? "" : enrolled.error);
  const session = await spine.issueSession(actor.organizationId, actor.id);
  assert.ok(session.ok, session.ok ? "" : session.error);

  const page = await routeConsole(request(session.value.id), service);
  assert.equal(page.status, 200);
  assert.equal(page.headers["cache-control"], "no-store");
  // The blind spots are the point of the page, so they have to be on it.
  assert.match(page.body, /Blind spots/);
  assert.match(page.body, /EBPF/);
  assert.match(page.body, /PROXY/);
  assert.match(page.body, /SG-BEH-002/);
  // The page says which sources actually have a reader, and there are three now: syslog,
  // the NetFlow/IPFIX collector and the OTLP receiver. "Read" is still a statement about
  // the rules for every other source, and the page says so rather than implying a feed is live.
  assert.match(page.body, /three sources have a reader/);
  assert.match(page.body, /NETFLOW/);
  assert.match(page.body, /OTEL/);
});

test("coverage: every value on the page is escaped", () => {
  const hostile = rule({
    id: "SG-X",
    name: "<script>alert(1)</script>",
    appliesTo: { kinds: ["<img src=x>"] },
  });
  const view: ConsoleCoverageView = {
    actor: { identifier: "a@b.test", displayName: "A", role: "ADMIN", organizationName: "Acme", organizationSlug: "acme" },
    session: { id: "s", issuedAt: "t", expiresAt: "t", lastSeenAt: "t" },
    report: coverageReport([hostile]),
    generatedAt: "2026-10-30T09:00:00.000Z",
  };
  const html = renderCoverage(view);

  assert.equal(html.includes("<script>alert(1)</script>"), false, "a rule name is somebody else's text");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.includes("<img src=x>"), false);
  assert.match(html, /&lt;img src=x&gt;/);
});
