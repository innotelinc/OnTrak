/**
 * The lab pack's Spanish copy, imported into the family's overlay (2.3).
 *
 * A bundled scenario's `i18n.es` block is authored in the lab's vocabulary — a title, a
 * briefing, objectives keyed by `id` and hints in order. This suite holds the two claims
 * that make importing it safe: the overlay reaches the definition (objective, brief, tasks,
 * hints) and the catalogue columns, and it changes text only — the authored record and the
 * empty `checks` array come through exactly as they went in.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { importLabScenario } from "../src/lib/lab-scenario-import";
import { localizeDefinition } from "../src/lib/scenario-i18n";

const SPANISH = {
  title: "El despliegue nocturno dejó de ejecutarse",
  briefing: "app-01 ejecuta un despliegue nocturno desde /srv/app/deploy.sh. Anoche se detuvo.",
  objectives: {
    "deploy-executable": "deploy.sh es ejecutable por su dueño y su grupo, y por nadie más (750)",
    "deploy-runs": "Ejecutar deploy.sh ahora termina e informa éxito",
  },
  hints: ["Empieza con ls -l /srv/app.", "750 significa dueño y grupo, nadie más."],
};

function pack(extra: Record<string, unknown> = {}) {
  return {
    id: "example-locale",
    title: "The nightly deployment stopped running",
    platform: "linux",
    workload: "ubuntu-24.04",
    briefing: "app-01 runs a nightly deployment from /srv/app/deploy.sh. It stopped last night.",
    objectives: [
      { id: "deploy-executable", text: "deploy.sh is runnable by its owner and group (750)" },
      { id: "deploy-runs", text: "Running deploy.sh completes and reports success" },
    ],
    hints: ["Start with ls -l /srv/app.", "750 means owner and group, nobody else."],
    ...extra,
  };
}

test("lab import 2.3: a Spanish pack reads in Spanish end to end", () => {
  const result = importLabScenario(pack({ i18n: { es: SPANISH } }));
  assert.ok(result.ok);

  const localized = localizeDefinition(result.scenario.definition, "es");
  assert.equal(localized.objective, SPANISH.title);
  assert.equal(localized.brief, SPANISH.briefing);
  assert.deepEqual(localized.tasks, [SPANISH.objectives["deploy-executable"], SPANISH.objectives["deploy-runs"]]);
  assert.equal(localized.hints?.[0].text, SPANISH.hints[0]);
  assert.equal(localized.hints?.[1].text, SPANISH.hints[1]);
});

test("lab import 2.3: the catalogue columns carry the Spanish title and summary", () => {
  const result = importLabScenario(pack({ i18n: { es: SPANISH } }));
  assert.ok(result.ok);
  assert.equal(result.scenario.titleEs, SPANISH.title);
  assert.match(result.scenario.summaryEs ?? "", /^app-01 ejecuta un despliegue nocturno/);
});

test("lab import 2.3: the translation changes no structure the grader reads", () => {
  const result = importLabScenario(pack({ i18n: { es: SPANISH } }));
  assert.ok(result.ok);
  const localized = localizeDefinition(result.scenario.definition, "es");

  // The lab's grading gap is unchanged: the overlay cannot invent a check to be graded by.
  assert.equal(result.scenario.definition.checks.length, 0);
  assert.equal(localized.checks.length, 0);
  // And the authored record is still the record.
  assert.equal(result.scenario.title, "The nightly deployment stopped running");
  assert.equal(result.scenario.definition.objective, result.scenario.title.slice(0, 70));
  assert.equal(result.scenario.definition.brief, pack().briefing);
});

test("lab import 2.3: a pack with no translations reads exactly as before", () => {
  const result = importLabScenario(pack());
  assert.ok(result.ok);
  assert.equal(result.scenario.titleEs, null);
  assert.equal(result.scenario.summaryEs, null);
  assert.equal(result.scenario.definition.i18n, undefined);
  // The same object, not a copy with empty strings applied.
  assert.equal(localizeDefinition(result.scenario.definition, "es"), result.scenario.definition);
});

test("lab import 2.3: an incomplete Spanish block falls back per string", () => {
  const partial = { ...SPANISH, objectives: { "deploy-runs": "Solo la segunda" }, hints: [""] };
  const result = importLabScenario(pack({ i18n: { es: partial } }));
  assert.ok(result.ok);
  const localized = localizeDefinition(result.scenario.definition, "es");

  assert.equal(localized.tasks[0], "deploy.sh is runnable by its owner and group (750)");
  assert.equal(localized.tasks[1], "Solo la segunda");
  assert.equal(localized.hints?.[0].text, "Start with ls -l /srv/app.");
});
