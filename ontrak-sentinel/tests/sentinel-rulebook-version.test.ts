/**
 * OnTrak Sentinel S3 tests: the **rule set's own id**.
 *
 * A per-rule `version` answers "which version of *this* rule fired" and is already on every
 * alert. It does not answer the other half of "why did this fire last Tuesday" — *which
 * corpus was running?* — and the cases below are the three ways that question gets asked:
 *
 *  - **A reordering is not a change.** The list's order is not meaningful, so the id must not
 *    move when the order does; otherwise a refactor reads as a rule change and the id stops
 *    being worth anything.
 *  - **A version bump moves it.** The declared version is part of what ran.
 *  - **A match edited without a bump still moves it.** This is the one a per-rule version
 *    cannot catch by itself: the number stays the same while the code that judges traffic
 *    changes, and a deployment that forgot to bump is *told* rather than left with an alert
 *    that reads as judged by a rule it never ran.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DETECTION_RULES,
  SCAN_RULE,
  SUSPICIOUS_SERVICE_RULE,
  rulebookVersion,
  type DetectionRule,
} from "../src/lib/detection-rules";

/** A copy of a shipped rule with only the named field changed. */
function withRule(changes: Partial<DetectionRule>): DetectionRule {
  return { ...SUSPICIOUS_SERVICE_RULE, ...changes };
}

test("the rule set has an id, and it is stable", () => {
  const version = rulebookVersion();
  assert.match(version, /^[0-9a-f]{12}$/);
  assert.equal(rulebookVersion(DETECTION_RULES), version, "the same set is the same id");
});

test("reordering the rules is not a change to the corpus", () => {
  const forwards = rulebookVersion([SUSPICIOUS_SERVICE_RULE, SCAN_RULE]);
  const backwards = rulebookVersion([SCAN_RULE, SUSPICIOUS_SERVICE_RULE]);
  assert.equal(forwards, backwards, "the list's order is not meaningful, so the id must not move");
});

test("bumping a rule's version moves the corpus id", () => {
  const before = rulebookVersion([withRule({})]);
  const after = rulebookVersion([withRule({ version: SUSPICIOUS_SERVICE_RULE.version + 1 })]);
  assert.notEqual(before, after);
});

test("editing a match without bumping the version still moves the corpus id", () => {
  const original = withRule({});
  assert.equal(original.detection.kind, "signature");
  const match = original.detection.kind === "signature" ? original.detection.match : {};

  // The number is deliberately left alone: this is the deployment that forgot, and the
  // corpus id is what makes that visible instead of silent.
  const edited = withRule({
    detection: { kind: "signature", match: { ...match, destinationPorts: [4242] } },
  });
  assert.equal(edited.version, original.version);
  assert.notEqual(
    rulebookVersion([original]),
    rulebookVersion([edited]),
    "a shape change must move the id even when the declared version did not",
  );
});

test("a rule joining or leaving the set moves the corpus id", () => {
  const two = rulebookVersion([SUSPICIOUS_SERVICE_RULE, SCAN_RULE]);
  const three = rulebookVersion([SUSPICIOUS_SERVICE_RULE, SCAN_RULE, DETECTION_RULES[2]!]);
  assert.notEqual(two, three);
  assert.notEqual(two, rulebookVersion([SUSPICIOUS_SERVICE_RULE]));
});
