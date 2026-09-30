/**
 * The scenario text overlay (v1.1).
 *
 * What these tests are defending is one property above all others: a translation changes what
 * a reader sees and nothing else. So the suite pairs every "the student reads Spanish" case
 * with the authored structure it must not have moved — the number of tasks, the check ids, the
 * hint penalties — and asserts the authored definition itself is never mutated.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coverageSummary,
  isSupportedLocale,
  localizeCheckLabel,
  localizeDefinition,
  localizeHintText,
  localizedObjective,
  overlayCoverage,
  scenarioOverlay,
} from "../src/lib/scenario-i18n";
import { validateDefinition } from "../src/lib/validate";
import type { ScenarioDefinition } from "../src/lib/sim/types";

/** A small but complete definition, with every kind of authored text. */
function definition(): ScenarioDefinition {
  return {
    version: 1,
    platform: "LINUX",
    engine: "bash",
    objective: "Raise the internal wiki back to a healthy state.",
    brief: "The wiki is down. Bring it back and prove it.",
    tasks: ["Check the service", "Start the service", "Open the firewall", "Leave a note"],
    machine: { hostname: "wiki01", user: "student", os: "Ubuntu", version: "24.04" },
    checks: [
      { id: "svc-running", label: "nginx is running", kind: "service_state", name: "nginx", active: true, points: 2 },
      { id: "fw-open", label: "HTTP is allowed through the firewall", kind: "firewall_rule", name: "allow-80", action: "allow", points: 2 },
      { id: "note", label: "Recorded a root-cause note", kind: "note_matches", pattern: "nginx", points: 1 },
    ],
    hints: [
      { id: "hint-svc", text: "`systemctl status nginx` tells you whether the unit is active.", penalty: 1 },
      { id: "hint-fw", text: "Opening a port with ufw needs root: `sudo ufw allow 80/tcp`.", penalty: 1 },
    ],
    allowHints: true,
  };
}

const SPANISH = {
  objective: "Devuelve la wiki interna a un estado saludable.",
  tasks: ["Comprueba el servicio", "Inicia el servicio", "Abre el cortafuegos", "Deja una nota"],
  checks: { "svc-running": "nginx está en ejecución", "fw-open": "HTTP está permitido por el cortafuegos" },
  hints: { "hint-svc": "`systemctl status nginx` te dice si la unidad está activa." },
};

function translated(): ScenarioDefinition {
  return { ...definition(), i18n: { es: SPANISH } };
}

/* -------------------------------------------------------------------------- */
/*  Reading it in the reader's language                                       */
/* -------------------------------------------------------------------------- */

test("i18n: a scenario with no overlay reads exactly as authored, in every locale", () => {
  const authored = definition();
  assert.equal(scenarioOverlay(authored, "es"), null);
  // The *same object*, so a caller can apply this on a hot path without churning renders.
  assert.equal(localizeDefinition(authored, "es"), authored);
  assert.equal(localizeDefinition(authored, "en"), authored);
  assert.equal(localizeDefinition(authored, "fr"), authored);
});

test("i18n: the overlay translates the objective, tasks, checks and hints", () => {
  const localized = localizeDefinition(translated(), "es");
  assert.equal(localized.objective, SPANISH.objective);
  assert.deepEqual(localized.tasks, SPANISH.tasks);
  assert.equal(localized.checks[0].label, "nginx está en ejecución");
  assert.equal(localized.checks[1].label, "HTTP está permitido por el cortafuegos");
  assert.equal(localized.hints?.[0].text, SPANISH.hints["hint-svc"]);
});

test("i18n: a check or hint the overlay does not name keeps the authored text", () => {
  const localized = localizeDefinition(translated(), "es");
  // The scenario's own record of what it graded is still there, in English, for the part
  // nobody has translated — a mixture on screen beats a blank line.
  assert.equal(localized.checks[2].label, "Recorded a root-cause note");
  assert.equal(localized.hints?.[1].text, "Opening a port with ufw needs root: `sudo ufw allow 80/tcp`.");
});

test("i18n: a partially filled tasks array falls back per index, not per array", () => {
  const partial = { ...definition(), i18n: { es: { tasks: ["Solo la primera"] } } };
  const localized = localizeDefinition(partial, "es");
  assert.equal(localized.tasks[0], "Solo la primera");
  assert.equal(localized.tasks[1], "Start the service");
  assert.equal(localized.tasks.length, 4);
});

test("i18n: a blank translation is not a translation", () => {
  const blank = { ...definition(), i18n: { es: { objective: "   ", checks: { "svc-running": "" } } } };
  const localized = localizeDefinition(blank, "es");
  assert.equal(localized.objective, definition().objective);
  assert.equal(localized.checks[0].label, "nginx is running");
});

test("i18n: an unknown locale in the overlay is simply not the active one", () => {
  const onlyFrench = { ...definition(), i18n: { fr: { objective: "Remettre le wiki en état." } } };
  assert.equal(localizeDefinition(onlyFrench, "es").objective, definition().objective);
  assert.equal(localizeDefinition(onlyFrench, "fr").objective, "Remettre le wiki en état.");
  assert.equal(isSupportedLocale("fr"), false);
  assert.equal(isSupportedLocale("es"), true);
});

/* -------------------------------------------------------------------------- */
/*  What a translation must not be able to do                                 */
/* -------------------------------------------------------------------------- */

test("i18n: an overlay can never change how many tasks, checks or hints there are", () => {
  const hostile = {
    ...definition(),
    i18n: {
      es: {
        // A seventh task in a six-task scenario, and a check id the scenario does not have.
        tasks: ["1", "2", "3", "4", "5", "6", "7"],
        checks: { "made-up": "Un control que no existe" },
        hints: { "made-up-hint": "Una pista que no existe" },
      },
    },
  };
  const localized = localizeDefinition(hostile, "es");
  assert.equal(localized.tasks.length, 4);
  assert.equal(localized.checks.length, 3);
  assert.equal(localized.hints?.length, 2);
  // The invented check id is not consulted anywhere, so the label it supplied is not either.
  assert.ok(!localized.checks.some((check) => check.label === "Un control que no existe"));
});

test("i18n: a translation cannot move a hint's penalty or a check's points", () => {
  const localized = localizeDefinition(translated(), "es");
  assert.equal(localized.hints?.[0].penalty, 1);
  assert.equal(localized.checks[0].points, 2);
  assert.equal(localized.checks[1].kind, "firewall_rule");
});

test("i18n: localizing never mutates the definition it was given", () => {
  const authored = translated();
  const snapshot = JSON.stringify(authored);
  const localized = localizeDefinition(authored, "es");
  assert.notEqual(localized, authored);
  assert.equal(JSON.stringify(authored), snapshot, "the authored definition is the record");
  assert.equal(authored.tasks[0], "Check the service");
  assert.equal(authored.checks[0].label, "nginx is running");
  // And the machine, files and state a scenario boots from come through untouched.
  assert.equal(localized.machine.hostname, authored.machine.hostname);
});

test("i18n: a stored evaluation's label is translated by check id, not by its text", () => {
  const authored = translated();
  assert.equal(localizeCheckLabel(authored, "es", "svc-running", "nginx is running"), "nginx está en ejecución");
  // The stored row is the record, so a check with no translation is reported as it ran.
  assert.equal(localizeCheckLabel(authored, "es", "note", "Recorded a root-cause note"), "Recorded a root-cause note");
  assert.equal(localizeCheckLabel(authored, "en", "svc-running", "nginx is running"), "nginx is running");
  assert.equal(localizeCheckLabel(authored, "es", null, "Recorded a root-cause note"), "Recorded a root-cause note");
  assert.equal(localizeHintText(authored, "es", "hint-svc", "authored"), SPANISH.hints["hint-svc"]);
  assert.equal(localizeHintText(authored, "es", "hint-fw", "authored"), "authored");
});

test("i18n: the objective a student reads prefers a translation over the catalog blurb", () => {
  const authored = translated();
  // A translator wrote the goal, so the student gets it, not the English catalog summary.
  assert.equal(localizedObjective(authored, "es", "Fix the wiki"), SPANISH.objective);
  // No translation: the catalog's own summary still wins, as it did before v1.1.
  assert.equal(localizedObjective(authored, "en", "Fix the wiki"), "Fix the wiki");
  assert.equal(localizedObjective(definition(), "es", null), definition().objective);
  assert.equal(localizedObjective(definition(), "es", "   "), definition().objective);
});

/* -------------------------------------------------------------------------- */
/*  Telling an author what their overlay actually covers                      */
/* -------------------------------------------------------------------------- */

test("i18n: coverage counts what is translated and names what is not", () => {
  const [coverage] = overlayCoverage(translated());
  assert.equal(coverage.locale, "es");
  assert.equal(coverage.supported, true);
  assert.equal(coverage.objective, true);
  assert.deepEqual(coverage.tasks, { translated: 4, total: 4 });
  assert.deepEqual(coverage.checks, { translated: 2, total: 3, unknown: [] });
  assert.deepEqual(coverage.hints, { translated: 1, total: 2, unknown: [] });
  assert.deepEqual(coverage.problems, []);
  assert.match(coverageSummary([coverage]), /es: objective yes, tasks 4\/4, checks 2\/3, hints 1\/2/);
});

test("i18n: coverage reports a stale id, an unknown locale and an over-long task list", () => {
  const messy = {
    ...definition(),
    i18n: {
      fr: { objective: "Bonjour", tasks: ["a", "b", "c", "d", "e"], checks: { ghost: "Fantôme" }, hints: { "ghost-hint": "Fantôme" } },
    },
  };
  const [coverage] = overlayCoverage(messy);
  assert.equal(coverage.locale, "fr");
  assert.equal(coverage.supported, false);
  assert.deepEqual(coverage.checks.unknown, ["ghost"]);
  assert.deepEqual(coverage.hints.unknown, ["ghost-hint"]);
  // The over-long list is clamped in the count, so the number the author reads is the number
  // of tasks that will actually be translated.
  assert.equal(coverage.tasks.translated, 4);
  assert.equal(coverage.tasks.total, 4);
  const joined = coverage.problems.join(" ");
  assert.match(joined, /"fr" is not a locale this deployment offers/);
  assert.match(joined, /lists 5 tasks but the scenario has 4/);
  assert.match(joined, /unknown checks: ghost/);
  assert.match(joined, /unknown hints: ghost-hint/);
  assert.match(coverageSummary([coverage]), /fr: objective yes/);
});

test("i18n: a scenario with no translations says so rather than reporting zeros", () => {
  assert.deepEqual(overlayCoverage(definition()), []);
  assert.match(coverageSummary([]), /No translations/);
});

test("i18n: an overlay that is not an object is described, not trusted", () => {
  const broken = { ...definition(), i18n: { es: "Español" as unknown as Record<string, never> } };
  const [coverage] = overlayCoverage(broken);
  assert.equal(coverage.objective, false);
  assert.match(coverage.problems.join(" "), /is not an object/);
  assert.equal(localizeDefinition(broken, "es").objective, definition().objective);
});

/* -------------------------------------------------------------------------- */
/*  The validator                                                             */
/* -------------------------------------------------------------------------- */

test("i18n: the validator keeps the overlay rather than stripping it", () => {
  const result = validateDefinition(translated());
  assert.ok(result.ok);
  assert.deepEqual(result.definition?.i18n, { es: SPANISH });
});

test("i18n: a stale overlay is a warning, never an error — the scenario still runs", () => {
  const messy = {
    ...definition(),
    i18n: { fr: { checks: { ghost: "Fantôme" } } },
  };
  const result = validateDefinition(messy);
  assert.ok(result.ok, "a bad translation does not stop a scenario being saved");
  assert.equal(result.issues.filter((issue) => issue.level === "error").length, 0);
  const overlayIssues = result.issues.filter((issue) => issue.field?.startsWith("i18n."));
  // One message per problem, and each one names its locale: the unknown locale tag and the
  // check id the scenario does not have.
  assert.equal(overlayIssues.length, 2);
  assert.ok(overlayIssues.every((issue) => issue.field === "i18n.fr"));
  assert.ok(overlayIssues.some((issue) => /is not a locale this deployment offers/.test(issue.message)));
  assert.ok(overlayIssues.some((issue) => /unknown checks: ghost/.test(issue.message)));
});

test("i18n: a translation of the objective does not change what the grader grades", () => {
  const authored = translated();
  const localized = localizeDefinition(authored, "es");
  // The structural fields every check reads are identical, whatever the overlay says.
  assert.deepEqual(
    localized.checks.map((check) => ({ ...check, label: null })),
    authored.checks.map((check) => ({ ...check, label: null })),
  );
  assert.equal(localized.allowHints, true);
  assert.equal(localized.brief, authored.brief);
});
