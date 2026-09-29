import assert from "node:assert/strict";
import test from "node:test";

/**
 * Session bookkeeping that the API and the UI both rely on. The interesting
 * part is the fallback chain, because "absent" and "empty" have to stay
 * distinguishable: one means "use the server default", the other means "never
 * try anything else".
 */

const { normalizeModelList, normalizeFlag, MAX_FALLBACKS } = await import("../store.js");

test("flag normalisation", async (t) => {
  await t.test("passes booleans through", () => {
    assert.equal(normalizeFlag(true), true);
    assert.equal(normalizeFlag(false), false);
  });

  await t.test("accepts the strings curl sends", () => {
    assert.equal(normalizeFlag("true"), true);
    assert.equal(normalizeFlag("false"), false);
  });

  await t.test("absent stays absent, so it cannot overwrite a saved choice", () => {
    assert.equal(normalizeFlag(undefined), undefined);
    assert.equal(normalizeFlag(null), undefined);
  });

  await t.test("ignores anything truthy that is not a flag", () => {
    // The whole point: "no" and 0 must not arrive as true.
    assert.equal(normalizeFlag("no"), undefined);
    assert.equal(normalizeFlag(0), undefined);
    assert.equal(normalizeFlag(1), undefined);
    assert.equal(normalizeFlag("FALSE"), undefined);
  });
});

test("fallback chain normalisation", async (t) => {
  await t.test("absent means \"use the server default\"", () => {
    assert.equal(normalizeModelList(undefined), undefined);
  });

  await t.test("empty is a deliberate choice, not the default", () => {
    assert.deepEqual(normalizeModelList([]), []);
    assert.deepEqual(normalizeModelList(""), []);
    assert.deepEqual(normalizeModelList(" , , "), []);
  });

  await t.test("accepts the comma-separated text the UI sends", () => {
    assert.deepEqual(normalizeModelList("a/one, b/two ,, c/three"), ["a/one", "b/two", "c/three"]);
  });

  await t.test("accepts an array and drops duplicates", () => {
    assert.deepEqual(normalizeModelList(["a/one", "a/one", " b/two "]), ["a/one", "b/two"]);
  });

  await t.test("ignores anything that is not a list of strings", () => {
    assert.equal(normalizeModelList(42), undefined);
    assert.equal(normalizeModelList({ a: 1 }), undefined);
    assert.deepEqual(normalizeModelList([1, "b/ok", null]), ["b/ok"]);
  });

  await t.test("caps the chain, so a careless paste cannot become a retry storm", () => {
    const many = Array.from({ length: MAX_FALLBACKS + 5 }, (_, index) => `m/${index}`);
    assert.equal(normalizeModelList(many)?.length, MAX_FALLBACKS);
  });

  await t.test("truncates an absurd model id", () => {
    const id = `m/${"x".repeat(400)}`;
    assert.equal(normalizeModelList([id])?.[0]?.length, 120);
  });
});
