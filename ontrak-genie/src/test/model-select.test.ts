import assert from "node:assert/strict";
import test from "node:test";

// A *type-only* import: it is erased at compile time, so it does not pull in
// `config.js` before the environment below is set.
import type { ModelHealthReport } from "../modelHealth.js";

/**
 * Which model an account is served, and who may choose one.
 *
 * The behaviour worth pinning is the *ordering*: the whole point of the automatic
 * chain is that a model whose credentials are cooling down is moved behind one
 * that answered the last check, so a turn does not open on a model that will
 * return a 429. Each case below is one way that ordering could go wrong —
 * dropping the unknown, dropping the pool when everything fails, or returning
 * nothing at all.
 *
 * The environment is set before the config module is imported, which is how every
 * suite in this project configures the deployment it is describing.
 */

process.env.AGENT_MODEL = "paid/primary";
process.env.AGENT_FALLBACK_MODELS = "paid/backup";
process.env.AGENT_FREE_MODELS = "free/a,free/b,free/c";
process.env.AGENT_FREE_PLANS = "free";

const { config } = await import("../config.js");
const { autoFreeChain, autoSelection, isFreePlan, selectionMode } = await import("../modelSelect.js");

function report(entries: Array<{ model: string; ok: boolean }>): ModelHealthReport {
  return {
    checkedAt: "2026-10-01T00:00:00.000Z",
    intervalMs: 0,
    entries: entries.map((entry) => ({
      model: entry.model,
      offline: false,
      ok: entry.ok,
      ms: entry.ok ? 120 : null,
      error: entry.ok ? null : "All credentials are cooling down",
    })),
    working: entries.filter((entry) => entry.ok).length,
    total: entries.length,
  };
}

test("a free plan gets the automatic model, a paid one keeps the picker", () => {
  assert.equal(isFreePlan("free"), true);
  assert.equal(isFreePlan("FREE"), true, "the comparison is case-insensitive");
  assert.equal(isFreePlan(""), true, "no plan at all is free, not a subscription");
  assert.equal(isFreePlan("pro"), false);
  assert.equal(isFreePlan("enterprise"), false, "a plan nobody listed is treated as paid");

  assert.equal(autoSelection("free"), true);
  assert.equal(autoSelection("pro"), false);
  assert.equal(selectionMode("free"), "auto");
  assert.equal(selectionMode("pro"), "manual");
});

test("the automatic chain puts a cooling-down model behind one that answered", () => {
  // `free/a` is first in configuration and failing its check; `free/b` answered.
  assert.deepEqual(
    autoFreeChain(
      report([
        { model: "free/a", ok: false },
        { model: "free/b", ok: true },
        { model: "free/c", ok: false },
      ]),
    ),
    ["free/b", "free/a", "free/c"],
  );
});

test("a model the check never looked at is unknown, not broken", () => {
  // Only `free/b` was probed; `a` and `c` were not. They must stay in the chain —
  // dropping them would silently shrink the pool to whatever happens to have a
  // report entry, which on a fresh deployment is nothing.
  assert.deepEqual(autoFreeChain(report([{ model: "free/b", ok: true }])), [
    "free/b",
    "free/a",
    "free/c",
  ]);
});

test("when every entry is cooling down the pool is returned, not emptied", () => {
  const all = report([
    { model: "free/a", ok: false },
    { model: "free/b", ok: false },
    { model: "free/c", ok: false },
  ]);
  // Order is configuration order: there is nothing to prefer, and an empty chain
  // would read as "no model is configured" rather than "everything is throttled".
  assert.deepEqual(autoFreeChain(all), ["free/a", "free/b", "free/c"]);
});

test("before the first check the pool is used in configured order", () => {
  const empty: ModelHealthReport = {
    checkedAt: null,
    intervalMs: 0,
    entries: [],
    working: 0,
    total: 0,
  };
  assert.deepEqual(autoFreeChain(empty), ["free/a", "free/b", "free/c"]);
});

test("the free pool is the curated list, and the paid chain is untouched", () => {
  assert.deepEqual(config.freeModels, ["free/a", "free/b", "free/c"]);
  assert.equal(config.model, "paid/primary");
  assert.deepEqual(config.fallbackModels, ["paid/backup"]);
  assert.deepEqual(config.freePlans, ["free"]);
});
