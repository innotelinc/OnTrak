/**
 * OnTrak Sentinel S3 tests: MITRE ATT&CK, made structured.
 *
 * A `MITRE:T1110` string is a citation, not a mapping. What these tests hold the module to is
 * the difference between the two:
 *
 *  - **The map is read off the rules.** Adding a technique to a rule has to move the map, and a
 *    rule that names none has to be *reported* as unmapped rather than counted as covering
 *    whatever tactic somebody assumes it does.
 *  - **A technique the catalogue does not carry is not "no technique".** Those are different
 *    failures — a typo, versus a detection nobody has placed on the kill chain — and a report
 *    that merged them would let a typo read as coverage.
 *  - **A tactic nothing answers is named.** The gap list is the reason the report exists; a map
 *    of ATT&CK that only lists what is covered is a map of the catalogue, not of the rulebook.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ATTACK_TACTICS,
  ATTACK_TECHNIQUES,
  attackReferences,
  attackReport,
  parseReferences,
  techniqueById,
  tacticTitle,
} from "../src/lib/attack-rules";
import { DETECTION_RULES, type DetectionRule } from "../src/lib/detection-rules";

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

test("attack: references split into framework and code, and an unreadable one is reported", () => {
  const { parsed, unparsed } = parseReferences(["MITRE:T1021.002", "CIS:4.1", "no-prefix", "  ", "ISO27001:A.9.4.2"]);
  assert.deepEqual(
    parsed.map((entry) => `${entry.framework}:${entry.code}`),
    ["MITRE:T1021.002", "CIS:4.1", "ISO27001:A.9.4.2"],
  );
  // A reference with no framework is *reported*, not guessed at: deciding that a bare `4.1`
  // means CIS would be this module inventing a citation the rule never made.
  assert.deepEqual(unparsed, ["no-prefix", ""]);
  assert.equal(parsed[2].raw, "ISO27001:A.9.4.2", "the citation is quotable exactly as written");
});

test("attack: technique ids are read out of a reference list in order and upper-cased", () => {
  assert.deepEqual(attackReferences(["MITRE:t1110", "CIS:9.3", "MITRE:T1078"]), ["T1110", "T1078"]);
  assert.deepEqual(attackReferences([]), []);
});

test("attack: the catalogue knows the tactics a technique serves, and admits what it does not carry", () => {
  assert.deepEqual(techniqueById("t1078")?.tactics, ["initial-access", "persistence", "privilege-escalation", "defense-evasion"]);
  assert.equal(techniqueById("T9999"), null);
  assert.equal(ATTACK_TACTICS.length, 14, "the enterprise matrix's tactics, in kill-chain order");
  assert.equal(tacticTitle("command-and-control"), "Command and Control");
  // Sub-techniques are first-class: a rule that names T1021.002 is more specific than one that
  // names T1021, and reporting them as one entry would hide which it was.
  assert.ok(ATTACK_TECHNIQUES.some((technique) => technique.id === "T1021.002"));
});

test("attack: the shipped rulebook's coverage is derived from the rules, gaps included", () => {
  const report = attackReport(DETECTION_RULES);

  // Every shipped rule cites a technique this catalogue carries, so nothing is unmapped and
  // nothing is uncatalogued — and if either list stops being empty, that is a real finding.
  assert.deepEqual(report.unmappedRules, []);
  assert.deepEqual(report.uncatalogued, []);
  assert.deepEqual(report.unparsedReferences, []);
  assert.equal(report.catalogComplete, false, "the report always says its denominator");

  // A technique's readers are the rules that named it, not a hand-maintained list.
  const lateral = report.techniques.find((entry) => entry.id === "T1021.002");
  assert.deepEqual(lateral?.rules, ["SG-BEH-004"]);
  assert.deepEqual(lateral?.tactics, ["lateral-movement"]);

  const byTactic = Object.fromEntries(report.tactics.map((entry) => [entry.tactic, entry]));
  for (const tactic of [
    "reconnaissance",
    "initial-access",
    "execution",
    "persistence",
    "privilege-escalation",
    "defense-evasion",
    "credential-access",
    "discovery",
    "lateral-movement",
    "command-and-control",
    "impact",
  ] as const) {
    assert.equal(byTactic[tactic].covered, true, `${tactic} should be answered`);
    assert.ok(byTactic[tactic].rules.length > 0);
    assert.ok(byTactic[tactic].techniques.length > 0);
  }

  // The tactics no rule answers. This is the report's whole value, and a rulebook that grew a
  // rule for one of them would have to *lose* an entry here rather than keep a stale claim.
  assert.deepEqual(
    report.gaps.map((gap) => gap.tactic),
    ["resource-development", "collection", "exfiltration"],
  );
  for (const gap of report.gaps) {
    assert.ok(gap.detail.length > 0, "a gap with no explanation is a bare accusation");
    assert.match(gap.detail, /produces telemetry the platform stores and raises nothing about/);
  }

  // The two rules that answer reconnaissance are the ones that cite its technique — and the
  // duplicate T1190 across two rules is de-duplicated into one entry with two readers.
  assert.deepEqual(byTactic.reconnaissance.rules, ["SG-HTTP-001"]);
  assert.deepEqual(report.techniques.find((entry) => entry.id === "T1190")?.rules, ["SG-HOST-002", "SG-HTTP-001"]);
});

test("attack: a rule naming an unknown technique is reported, not read as coverage", () => {
  const report = attackReport([
    rule({ id: "SG-A", references: ["MITRE:T1110"] }),
    rule({ id: "SG-B", references: ["MITRE:T0000"] }),
    rule({ id: "SG-C", references: ["CIS:4.1"] }),
    rule({ id: "SG-D", references: ["bare-reference"] }),
  ]);

  assert.deepEqual(report.uncatalogued, [{ id: "T0000", rules: ["SG-B"] }]);
  assert.deepEqual(report.unmappedRules, ["SG-C", "SG-D"], "no MITRE reference is not a mapping");
  assert.deepEqual(report.unparsedReferences, [{ ruleId: "SG-D", reference: "bare-reference" }]);
  // The uncatalogued technique contributes no tactic, so credential access is answered only by
  // the rule that named a technique the catalogue knows.
  const credential = report.tactics.find((entry) => entry.tactic === "credential-access");
  assert.deepEqual(credential?.rules, ["SG-A"]);
});

test("attack: reordering the rulebook does not move the map", () => {
  const forwards = attackReport(DETECTION_RULES);
  const backwards = attackReport([...DETECTION_RULES].reverse());
  assert.deepEqual(forwards.techniques, backwards.techniques, "the list's order is not meaningful");
  assert.deepEqual(forwards.tactics, backwards.tactics);
});
