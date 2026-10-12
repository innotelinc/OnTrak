/**
 * OnTrak Sentinel tests: the sample telemetry corpus, driven through the shipped rulebook.
 *
 * The corpus exists so an operator can fill a live console with detections in one command, and
 * so the rulebook is *driven* rather than merely described. That second job is what this file
 * holds to:
 *
 *  - **Every sample raises the rule it names.** A batch with no `expect` entry, or one whose
 *    rule no longer fires, is a sample that lies about what the deployment detects — so the
 *    assertion is per-batch and names the rule, not "something fired".
 *  - **The samples go through the real normalizer.** Payloads are folded with the same
 *    `toObservedEvent` the ingest surface calls, so a sample that only fires because the test
 *    built an `ObservedEvent` by hand would fail here instead.
 *  - **No sample is accepted as noise.** A payload the normalizer refuses is a sample nobody
 *    can actually post, and is reported as such rather than skipped.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DETECTION_RULES, evaluateRules } from "../src/lib/detection-rules";
import { sampleBatches } from "../src/lib/detection-samples";
import { toObservedEvent, type ObservedEvent } from "../src/lib/telemetry-rules";

const NOW = Date.parse("2026-11-01T08:00:00.000Z");

test("samples: every batch normalizes, and raises the rule(s) it names", () => {
  const shipped = new Set(DETECTION_RULES.map((rule) => rule.id));

  for (const batch of sampleBatches(NOW)) {
    const events: ObservedEvent[] = [];
    for (const payload of batch.events) {
      const normalized = toObservedEvent(batch.source, payload, { sensor: batch.sensor, at: NOW });
      assert.ok(normalized.ok, `${batch.name}: a sample payload was refused — ${JSON.stringify(normalized.ok ? [] : normalized.issues)}`);
      events.push(normalized.event);
    }
    assert.equal(events.length, batch.events.length, `${batch.name}: every event is an observation`);

    const fired = new Set(evaluateRules(events, DETECTION_RULES).map((draft) => draft.ruleId));
    assert.ok(fired.size > 0, `${batch.name}: raised nothing at all`);
    for (const expected of batch.expect) {
      assert.ok(shipped.has(expected), `${batch.name}: names ${expected}, which is not a shipped rule`);
      assert.ok(fired.has(expected), `${batch.name}: expected ${expected} to fire, got ${[...fired].join(", ") || "nothing"}`);
    }
  }
});

test("samples: every shipped rule has at least one sample that drives it", () => {
  // The corpus is meant to cover the rulebook. A rule with no sample is a rule nobody has
  // driven end to end, which is exactly the gap this corpus exists to close.
  const driven = new Set(sampleBatches(NOW).flatMap((batch) => batch.expect));
  const undriven = DETECTION_RULES.map((rule) => rule.id).filter((id) => !driven.has(id));
  assert.deepEqual(undriven, [], `undriven rules: ${undriven.join(", ")}`);
});
