/**
 * The fleet roll-up on the front door.
 *
 * The tiles already carry a light each; this is the sentence above them, and the
 * reason it is a pure function is that a sentence computed separately from the
 * lights is a sentence that can disagree with them. These cases hold the three
 * things the dashboard promised:
 *
 *   * a product nobody could check is **not checked**, never "up";
 *   * "not answering" outranks "not checked" in the attention list, because a fact
 *     beats an absence;
 *   * the headline reads honestly in every combination — all up, some down, none
 *     checkable, and no products at all for the role.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { summarizeFleet, type FleetStatusEntry } from "../src/lib/portal-rules";

const TILES = [
  { key: "its", name: "OnTrak IT Support Training" },
  { key: "tix", name: "OnTrak Tix" },
  { key: "sentinel", name: "OnTrak Sentinel" },
] as const;

function statuses(entries: Record<string, FleetStatusEntry>): Map<string, FleetStatusEntry | undefined> {
  return new Map(Object.entries(entries));
}

test("all answering is said plainly", () => {
  const summary = summarizeFleet(TILES, statuses({
    its: { reachability: "up", detail: "200 OK" },
    tix: { reachability: "up", detail: "200 OK" },
    sentinel: { reachability: "up", detail: "401 Unauthorized" },
  }));
  assert.equal(summary.headline, "all 3 products answering");
  assert.deepEqual(summary.attention, []);
  assert.deepEqual({ up: summary.up, down: summary.down, unknown: summary.unknown },
    { up: 3, down: 0, unknown: 0 });
});

test("a missing status is not-checked, never up", () => {
  const summary = summarizeFleet(TILES, statuses({
    its: { reachability: "up", detail: "200 OK" },
  }));
  // tix and sentinel were never asked.
  assert.equal(summary.up, 1);
  assert.equal(summary.unknown, 2);
  assert.equal(summary.down, 0);
  assert.equal(summary.attention.length, 2);
  for (const entry of summary.attention) {
    assert.equal(entry.reachability, "unknown");
    assert.equal(entry.detail, "not checked");
  }
});

test("not answering outranks not checked", () => {
  const summary = summarizeFleet(TILES, statuses({
    its: { reachability: "unknown", detail: "not checked" },
    tix: { reachability: "down", detail: "connect ECONNREFUSED" },
    sentinel: { reachability: "up", detail: "200 OK" },
  }));
  assert.deepEqual(summary.attention.map((entry) => entry.key), ["tix", "its"]);
  assert.equal(summary.attention[0]?.reachability, "down");
  assert.equal(summary.headline, "1 of 3 answering · 1 not answering · 1 not checked");
});

test("nothing checkable is said as such, not as healthy or broken", () => {
  const summary = summarizeFleet(TILES, statuses({}));
  assert.equal(summary.headline, "no product could be checked");
  assert.equal(summary.up, 0);
  assert.equal(summary.down, 0);
  assert.equal(summary.unknown, 3);
});

test("a role with no products is an empty state, not a broken one", () => {
  const summary = summarizeFleet([], statuses({}));
  assert.equal(summary.total, 0);
  assert.equal(summary.headline, "no products for this role");
  assert.deepEqual(summary.attention, []);
});

test("the singular reads correctly", () => {
  const summary = summarizeFleet([{ key: "tix", name: "OnTrak Tix" }], statuses({
    tix: { reachability: "up", detail: "200 OK" },
  }));
  assert.equal(summary.headline, "all 1 product answering");
});
