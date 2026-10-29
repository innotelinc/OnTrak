import assert from "node:assert/strict";
import test from "node:test";

/**
 * Choosing an instruction set.
 *
 * Two things matter and are pinned here: an id nobody recognises must resolve to
 * the default rather than to no prompt (a turn with an empty system message is
 * the worst of both worlds), and every preset must keep the boundaries — paths
 * relative to the workspace, no host privileges, no credentials from outside it.
 * The second is a *content* assertion on purpose: shortening a prompt is exactly
 * the edit that drops the line nobody was reading it for.
 */
const { DEFAULT_PROMPT_ID, PROMPTS, promptCatalog, promptFor, promptText, resolvePromptId } = await import(
  "../prompts.js"
);
const { SYSTEM_PROMPT } = await import("../agent.js");

test("resolving a preset id", async (t) => {
  await t.test("accepts every id it publishes", () => {
    for (const preset of PROMPTS) assert.equal(resolvePromptId(preset.id), preset.id);
  });

  await t.test("is forgiving about case and surrounding space", () => {
    assert.equal(resolvePromptId("  CONCISE "), "concise");
    assert.equal(resolvePromptId("Tiny"), "tiny");
  });

  await t.test("does not invent one for an id it does not know", () => {
    assert.equal(resolvePromptId("verbose"), undefined);
    assert.equal(resolvePromptId(""), undefined);
    assert.equal(resolvePromptId(undefined), undefined);
    assert.equal(resolvePromptId(42), undefined);
    assert.equal(resolvePromptId({ id: "tiny" }), undefined);
  });
});

test("a preset nobody named is the default, never an empty prompt", () => {
  assert.equal(promptFor(undefined).id, DEFAULT_PROMPT_ID);
  assert.equal(promptFor("nope").id, DEFAULT_PROMPT_ID);
  assert.equal(promptText("nope"), promptText("default"));
  assert.ok(promptText(undefined).length > 500);
});

test("the catalog the console renders", () => {
  const catalog = promptCatalog();
  assert.equal(catalog.length, PROMPTS.length);
  assert.equal(catalog.filter((entry) => entry.default).length, 1);
  assert.equal(catalog.find((entry) => entry.default)?.id, DEFAULT_PROMPT_ID);
  for (const entry of catalog) {
    assert.equal(typeof entry.name, "string");
    assert.ok(entry.name.length > 0);
    assert.ok(entry.description.length > 20, `${entry.id} needs a sentence saying when to pick it`);
  }
});

test("every preset keeps the boundaries", () => {
  for (const preset of PROMPTS) {
    const text = promptText(preset.id);
    assert.match(text, /workspace/i, `${preset.id} must say where the agent works`);
    assert.match(text, /no host privileges|Never try to escalate/i, `${preset.id} must keep the boundary`);
    assert.match(text, /credential/i, `${preset.id} must say not to go looking for credentials`);
  }
});

test("the presets are ordered by how much they say", () => {
  const full = promptText("default").length;
  const concise = promptText("concise").length;
  const tiny = promptText("tiny").length;
  assert.ok(concise < full / 2, `concise (${concise}) should be well under half of default (${full})`);
  assert.ok(tiny < concise / 2, `tiny (${tiny}) should be well under half of concise (${concise})`);
});

test("the agent's exported prompt is the default preset", () => {
  assert.equal(SYSTEM_PROMPT, promptText("default"));
});
