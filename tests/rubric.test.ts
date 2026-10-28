/**
 * Rubric bands and competencies (2.2).
 *
 * The claim this milestone makes is narrow and checkable: a check can award 0,
 * half or full credit, and a certificate's competencies are the checks that
 * earned them rather than a scenario-wide label. So these tests grade real
 * definitions rather than trusting the shape:
 *
 *   * a half band is exactly half of its parent, is not a line of its own, and is
 *     not a pass — `missedChecks` still says the work is incomplete;
 *   * grading the same snapshot twice is the same report, because a re-grade is
 *     the product's promise and a band that depended on order or a clock would
 *     break it;
 *   * the validator refuses the bands that would award nothing or mean two things;
 *   * a certificate carries the competencies its full-credit checks earned, with
 *     the scenario's tags only for a catalog that tags no check.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/rubric.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { certificateForAttempt } from "../src/lib/certificates";
import { certificateSkillsFor, competencyTally, halfCreditFor } from "../src/lib/rubric-rules";
import { gradeAttempt, missedChecks } from "../src/lib/sim/grade";
import { createInitialState } from "../src/lib/sim/state";
import type { CheckEvaluation, ScenarioDefinition } from "../src/lib/sim/types";
import { validateDefinition } from "../src/lib/validate";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One scenario covering all three bands.
 *
 * The parent/band pairs are deliberately ordinary checks: a half band is the
 * weaker condition in the vocabulary the author already uses, not a second
 * language for rubrics.
 */
const SCENARIO: ScenarioDefinition = {
  version: 1,
  platform: "LINUX",
  engine: "bash",
  objective: "Harden SSH on the jump host.",
  brief: "Password sign-in and direct root sign-in are both on. Turn them off.",
  tasks: ["Disable password authentication", "Disable direct root sign-in"],
  machine: { hostname: "jump01", user: "student", os: "Ubuntu 24.04.2 LTS", version: "24.04" },
  files: [
    {
      path: "/home/student/ssh.conf",
      content: "PasswordAuthentication no\nPermitRootLogin no\n",
      mode: "644",
    },
    {
      path: "/home/student/partial.conf",
      content: "PasswordAuthentication no\n",
      mode: "644",
    },
  ],
  checks: [
    {
      id: "ssh-hardened",
      label: "SSH is hardened",
      kind: "file_contains",
      path: "/home/student/ssh.conf",
      pattern: "PermitRootLogin no",
      points: 4,
      competency: "Linux hardening",
    },
    {
      id: "ssh-password-off",
      label: "Password auth disabled",
      kind: "file_contains",
      path: "/home/student/ssh.conf",
      pattern: "PasswordAuthentication no",
      halfOf: "ssh-hardened",
    },
    {
      id: "partial",
      label: "Password auth is off",
      kind: "file_contains",
      path: "/home/student/partial.conf",
      pattern: "PermitRootLogin no",
      points: 2,
      competency: "Linux hardening",
    },
    {
      id: "partial-band",
      label: "At least one setting changed",
      kind: "file_contains",
      path: "/home/student/partial.conf",
      pattern: "PasswordAuthentication no",
      halfOf: "partial",
    },
    {
      id: "never",
      label: "DNS is fixed",
      kind: "file_exists",
      path: "/home/student/no-such-file",
      points: 2,
      competency: "DNS",
    },
    {
      id: "never-band",
      label: "Resolver touched",
      kind: "file_exists",
      path: "/home/student/no-such-file-either",
      halfOf: "never",
    },
  ],
};

function report() {
  return gradeAttempt(SCENARIO, createInitialState(SCENARIO), 70);
}

/* -------------------------------------------------------------------------- */
/*  Bands                                                                     */
/* -------------------------------------------------------------------------- */

test("rubric: a half band is exactly half, and it is not a pass", () => {
  const graded = report();
  const partial = graded.results.find((result) => result.checkId === "partial");

  assert.equal(partial?.band, "half");
  assert.equal(partial?.passed, false, "half credit does not claim the work is complete");
  assert.equal(partial?.points, 1, "half of 2 points");
  assert.equal(partial?.maxPoints, 2);
  assert.equal(halfCreditFor(6), 3);

  // A missed check stays missed, which is what the report's own list means.
  assert.ok(missedChecks(graded).some((result) => result.checkId === "partial"));
});

test("rubric: a band that misses too earns nothing and stays at 0", () => {
  const graded = report();
  const never = graded.results.find((result) => result.checkId === "never");
  assert.equal(never?.band, "none");
  assert.equal(never?.points, 0);
  assert.equal(never?.detail.includes("Half credit"), false);
});

test("rubric: a passed parent is full credit even when its band would also pass", () => {
  const graded = report();
  const hardened = graded.results.find((result) => result.checkId === "ssh-hardened");
  assert.equal(hardened?.band, "full");
  assert.equal(hardened?.points, 4, "full credit, not full plus half");
  assert.equal(hardened?.competency, "Linux hardening");
});

test("rubric: a band is never a line of its own, and its points are not the parent's", () => {
  const graded = report();
  const ids = graded.results.map((result) => result.checkId);
  assert.deepEqual(ids, ["ssh-hardened", "partial", "never"], "one line per parent");
  assert.deepEqual(
    graded.bands?.map((band) => [band.checkId, band.parentId, band.passed]),
    [
      ["ssh-password-off", "ssh-hardened", true],
      ["partial-band", "partial", true],
      ["never-band", "never", false],
    ],
  );
  assert.equal(graded.maxScore, 8, "4 + 2 + 2, with the bands contributing nothing of their own");
  assert.equal(graded.score, 5, "4 full + 1 half + 0");
});

test("rubric: the half band's own words explain the half credit on the report", () => {
  const graded = report();
  const partial = graded.results.find((result) => result.checkId === "partial");
  assert.ok(partial?.detail.includes("partial.conf"), "the band's own evidence is quoted");
  assert.ok(partial?.detail.includes("Half credit for “Password auth is off”"));
});

test("rubric: grading the same snapshot twice is the same report", () => {
  // A re-grade is the product's promise: same stored state, same result. A band
  // that depended on evaluation order or a clock would fail here.
  const first = report();
  const second = report();
  assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(first)));
});

/* -------------------------------------------------------------------------- */
/*  Competencies                                                              */
/* -------------------------------------------------------------------------- */

test("rubric: a competency is earned only by a full-credit check", () => {
  const tallies = competencyTally(report().results);
  const linux = tallies.find((tally) => tally.skill === "Linux hardening");
  const dns = tallies.find((tally) => tally.skill === "DNS");

  assert.equal(linux?.earned, true);
  assert.deepEqual(linux?.checkIds, ["ssh-hardened", "partial"], "both checks carry the skill");
  assert.deepEqual(linux?.earnedCheckIds, ["ssh-hardened"], "the half band did not earn it");
  assert.equal(dns?.earned, false);
});

test("rubric: a certificate carries the earned checks, not the scenario's tags", () => {
  const graded = report();
  const skills = certificateSkillsFor(graded.results, ["ssh", "hardening"]);
  assert.deepEqual(skills, ["Linux hardening"], "the tagged skill, not the scenario tags");

  const record = certificateForAttempt({
    learnerId: "user-1",
    learnerName: "Ada Lovelace",
    scenarioId: "scenario-1",
    scenarioTitle: "Harden SSH",
    platform: "LINUX",
    score: graded.score,
    maxScore: graded.maxScore,
    passScore: 70,
    completedAt: new Date("2026-10-25T10:00:00.000Z"),
    skills,
  });
  assert.deepEqual(record.skills, ["Linux hardening"]);
});

test("rubric: an untagged scenario keeps the tags it always issued", () => {
  const results: CheckEvaluation[] = [
    { checkId: "a", label: "A", kind: "file_exists", passed: true, points: 1, maxPoints: 1, detail: "" },
  ];
  assert.deepEqual(certificateSkillsFor(results, ["linux", "dns"]), ["linux", "dns"]);
});

test("rubric: a scenario whose only tagged check lands in the half band earns nothing", () => {
  // Falling back to the scenario's tags here would attest a competence the work
  // did not demonstrate, which is the one thing the milestone exists to stop.
  const results: CheckEvaluation[] = [
    {
      checkId: "a",
      label: "A",
      kind: "file_exists",
      passed: false,
      band: "half",
      points: 1,
      maxPoints: 2,
      detail: "",
      competency: "linux",
    },
  ];
  assert.deepEqual(certificateSkillsFor(results, ["linux", "dns"]), []);
});

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...structuredClone(SCENARIO), ...overrides } as unknown as Record<string, unknown>;
}

function baseCheck(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "parent",
    label: "Parent",
    kind: "file_exists",
    path: "/home/student/ssh.conf",
    points: 2,
    ...overrides,
  };
}

function withChecks(checks: Record<string, unknown>[]): Record<string, unknown> {
  return definition({ files: [], checks });
}

function hasError(raw: Record<string, unknown>, pattern: RegExp): boolean {
  return validateDefinition(raw).issues.some((issue) => issue.level === "error" && pattern.test(issue.message));
}

function hasWarning(raw: Record<string, unknown>, pattern: RegExp): boolean {
  return validateDefinition(raw).issues.some((issue) => issue.level === "warning" && pattern.test(issue.message));
}

test("validator: a well-formed rubric validates and totals only its parents", () => {
  const result = validateDefinition(SCENARIO);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.totalPoints, 8);
});

test("validator: a band must name a real check", () => {
  assert.ok(
    hasError(withChecks([baseCheck(), baseCheck({ id: "band", label: "Band", halfOf: "nope" })]), /not a check in this scenario/),
  );
});

test("validator: a band on a band is refused", () => {
  assert.ok(
    hasError(
      withChecks([
        baseCheck(),
        baseCheck({ id: "band", label: "Band", halfOf: "parent" }),
        baseCheck({ id: "band2", label: "Band 2", halfOf: "band" }),
      ]),
      /itself a half band/,
    ),
  );
});

test("validator: a half band that awards nothing is refused, and odd points are refused", () => {
  assert.ok(
    hasError(
      withChecks([
        baseCheck({ points: 1 }),
        baseCheck({ id: "band", label: "Band", halfOf: "parent" }),
      ]),
      /even total of at least 2/,
    ),
  );
  assert.ok(
    hasError(
      withChecks([
        baseCheck({ points: 3 }),
        baseCheck({ id: "band", label: "Band", halfOf: "parent" }),
      ]),
      /even total of at least 2/,
    ),
  );
});

test("validator: one check cannot have two rubrics", () => {
  assert.ok(
    hasError(
      withChecks([
        baseCheck(),
        baseCheck({ id: "one", label: "One", halfOf: "parent" }),
        baseCheck({ id: "two", label: "Two", halfOf: "parent" }),
      ]),
      /already has a half band/,
    ),
  );
});

test("validator: points on a band are ignored rather than silently added", () => {
  const checks = [baseCheck(), baseCheck({ id: "band", label: "Band", halfOf: "parent", points: 9 })];
  assert.ok(hasWarning(withChecks(checks), /points.*ignored/));
  assert.equal(validateDefinition(withChecks(checks)).totalPoints, 2);
});

test("validator: a blank competency is an error, not an empty column", () => {
  assert.ok(hasError(withChecks([baseCheck({ competency: "  " })]), /competency/));
  assert.ok(hasError(withChecks([baseCheck({ competency: 4 })]), /competency/));
});

test("validator: a half band that already passes is warned about, like a free check", () => {
  const result = validateDefinition(
    definition({
      files: [{ path: "/home/student/ssh.conf", content: "PasswordAuthentication no\n", mode: "644" }],
      checks: [
        baseCheck({ path: "/home/student/missing-a" }),
        baseCheck({ id: "band", label: "Band", path: "/home/student/ssh.conf", halfOf: "parent" }),
      ],
    }),
  );
  assert.ok(
    result.issues.some(
      (issue) => issue.level === "warning" && /half-credit condition already passes/.test(issue.message),
    ),
    JSON.stringify(result.issues),
  );
});
