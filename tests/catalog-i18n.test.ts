/**
 * The catalogue's own copy, per locale (2.3).
 *
 * The property this suite defends is the same one the scenario overlay defends: a
 * translation changes what a reader sees and nothing else. Here that means a Spanish row
 * with half its columns translated reads as a mixture, never as a blank card — and an
 * English reader sees the authored copy even on a fully translated row.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogText } from "../src/lib/catalog-i18n";

const translated = {
  title: "A locked-out analyst during the month-end close",
  summary: "Unlock the account and end the stale session.",
  titleEs: "Una analista bloqueada durante el cierre de mes",
  summaryEs: "Desbloquea la cuenta y termina la sesión obsoleta.",
};

test("catalog i18n: a Spanish reader gets the Spanish columns", () => {
  assert.deepEqual(catalogText(translated, "es"), {
    title: translated.titleEs,
    summary: translated.summaryEs,
  });
});

test("catalog i18n: English and unknown locales get the authored columns", () => {
  assert.deepEqual(catalogText(translated, "en"), { title: translated.title, summary: translated.summary });
  // The deployment knows two locales; anything else is not a reason to show Spanish.
  assert.deepEqual(catalogText(translated, "fr"), { title: translated.title, summary: translated.summary });
});

test("catalog i18n: a row with no Spanish columns reads exactly as authored", () => {
  const untranslated = { title: "A locked-out analyst", summary: "Unlock the account." };
  assert.deepEqual(catalogText(untranslated, "es"), { title: untranslated.title, summary: untranslated.summary });
  assert.deepEqual(catalogText({ ...untranslated, titleEs: null, summaryEs: null }, "es"), {
    title: untranslated.title,
    summary: untranslated.summary,
  });
});

test("catalog i18n: fallback is per field, not per row", () => {
  const half = { ...translated, summaryEs: null };
  assert.deepEqual(catalogText(half, "es"), { title: translated.titleEs, summary: translated.summary });
  const otherHalf = { ...translated, titleEs: null };
  assert.deepEqual(catalogText(otherHalf, "es"), { title: translated.title, summary: translated.summaryEs });
});

test("catalog i18n: a blank translation is not a translation", () => {
  const blank = { ...translated, titleEs: "   ", summaryEs: "" };
  assert.deepEqual(catalogText(blank, "es"), { title: translated.title, summary: translated.summary });
});
