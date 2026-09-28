/**
 * Scenario-validator tests.
 *
 * `validateDefinition` is the gate between an author's JSON and a published
 * scenario, so its edge cases matter more than its happy path: a typo'd check
 * kind, a duplicated id or a regex that will not compile should be caught here
 * rather than in front of a class. All of it is pure, so none of this needs a
 * database.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { LINUX_TEMPLATE } from "../src/lib/templates";
import { CHECK_KINDS, expectedEngine, isCheckKind, validateDefinition } from "../src/lib/validate";
import type { ValidationResult } from "../src/lib/validate";

type Loose = Record<string, any>;

/** A mutable copy of a known-good scenario, so each test breaks exactly one thing. */
function definition(overrides: Loose = {}): Loose {
  const base = structuredClone(LINUX_TEMPLATE) as unknown as Loose;
  return { ...base, ...overrides };
}

/** One valid `file_exists` check, for tests that only care about the field under test. */
function oneCheck(overrides: Loose = {}): Loose[] {
  return [{ id: "the-check", label: "The check", kind: "file_exists", path: "/home/student/missing.txt", ...overrides }];
}

function errorsOf(result: ValidationResult): string[] {
  return result.issues.filter((issue) => issue.level === "error").map((issue) => issue.message);
}

function warningsOf(result: ValidationResult): string[] {
  return result.issues.filter((issue) => issue.level === "warning").map((issue) => issue.message);
}

function has(result: ValidationResult, level: "error" | "warning", pattern: RegExp): boolean {
  return result.issues.some((issue) => issue.level === level && pattern.test(issue.message));
}

/* -------------------------------------------------------------------------- */
/*  The happy path                                                            */
/* -------------------------------------------------------------------------- */

test("validator: a shipped template validates cleanly and totals its points", () => {
  const result = validateDefinition(LINUX_TEMPLATE);
  assert.equal(result.ok, true);
  assert.deepEqual(errorsOf(result), []);
  assert.ok(result.definition, "a valid definition is handed back");
  // 2 + 2 + 2 + 1 + 1 across the five checks in the Linux template.
  assert.equal(result.totalPoints, 8);
});

test("validator: warnings alone never fail a definition", () => {
  // A sheet check pointing at a document that does not exist is a warning, not
  // an error: the author may simply have not written the doc yet.
  const result = validateDefinition(
    definition({ checks: [{ id: "sheet", label: "Sheet", kind: "sheet_exists", doc: "nope.xlsx", sheet: "Sheet1" }] }),
  );
  assert.equal(result.ok, true);
  assert.ok(result.issues.length > 0);
  assert.ok(result.issues.every((issue) => issue.level === "warning"));
});

/* -------------------------------------------------------------------------- */
/*  The envelope                                                              */
/* -------------------------------------------------------------------------- */

test("validator: a payload that is not a definition is an error, not a crash", () => {
  for (const raw of [null, undefined, 42, "not json", [], { version: 1 }]) {
    const result = validateDefinition(raw);
    assert.equal(result.ok, false, `${String(raw)} should fail`);
    assert.equal(result.totalPoints, 0);
    assert.equal(result.definition, undefined);
    assert.ok(result.issues.every((issue) => issue.level === "error"));
  }
});

test("validator: the envelope names each missing field", () => {
  const result = validateDefinition({ version: 1 });
  const fields = result.issues.map((issue) => issue.field);
  for (const field of ["platform", "engine", "objective", "brief", "tasks", "machine", "checks"]) {
    assert.ok(fields.includes(field), `expected a complaint about ${field}`);
  }
});

test("validator: the version must be exactly 1", () => {
  const result = validateDefinition(definition({ version: 2 }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.field === "version"));
});

test("validator: objective, brief and tasks each have a minimum", () => {
  const result = validateDefinition(definition({ objective: "hi", brief: "too short", tasks: [] }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.field === "objective"));
  assert.ok(result.issues.some((issue) => issue.field === "brief"));
  assert.ok(result.issues.some((issue) => issue.field === "tasks"));
});

test("validator: a scenario needs at least one check", () => {
  const result = validateDefinition(definition({ checks: [] }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.field === "checks"));
});

/* -------------------------------------------------------------------------- */
/*  Platform and engine                                                       */
/* -------------------------------------------------------------------------- */

test("validator: the engine must match the platform", () => {
  assert.equal(expectedEngine("LINUX"), "bash");
  assert.equal(expectedEngine("WINDOWS"), "powershell");
  assert.equal(expectedEngine("OFFICE"), "office");

  const linux = validateDefinition(definition({ engine: "powershell" }));
  assert.equal(linux.ok, false);
  assert.ok(has(linux, "error", /LINUX platform expects the "bash" engine/));

  const windows = structuredClone(LINUX_TEMPLATE) as unknown as Loose;
  windows.platform = "WINDOWS";
  windows.engine = "bash";
  const result = validateDefinition(windows);
  assert.equal(result.ok, false);
  assert.ok(has(result, "error", /WINDOWS platform expects the "powershell" engine/));
});

test("validator: only Windows has a desktop surface", () => {
  const linux = validateDefinition(definition({ surface: "desktop" }));
  assert.equal(linux.ok, false);
  assert.ok(linux.issues.some((issue) => issue.field === "surface"));
  assert.ok(has(linux, "error", /has no desktop surface/));

  // Console is fine everywhere, and no surface at all is fine too.
  assert.equal(validateDefinition(definition({ surface: "console" })).ok, true);
  assert.equal(validateDefinition(definition({ surface: undefined })).ok, true);
});

/* -------------------------------------------------------------------------- */
/*  Checks: identity                                                          */
/* -------------------------------------------------------------------------- */

test("validator: every check needs a unique id and a label", () => {
  const noId = validateDefinition(
    definition({ checks: [{ label: "No id", kind: "file_exists", path: "/etc/hosts" }] }),
  );
  assert.equal(noId.ok, false);
  assert.ok(noId.issues.some((issue) => issue.field === "checks[0]" && /unique `id`/.test(issue.message)));

  const noLabel = validateDefinition(definition({ checks: [{ id: "a", kind: "file_exists", path: "/etc/hosts" }] }));
  assert.equal(noLabel.ok, false);
  assert.ok(noLabel.issues.some((issue) => issue.field === "a" && /`label`/.test(issue.message)));

  const blankLabel = validateDefinition(
    definition({ checks: [{ id: "a", label: "   ", kind: "file_exists", path: "/etc/hosts" }] }),
  );
  assert.equal(blankLabel.ok, false);
});

test("validator: a duplicated check id is an error", () => {
  const result = validateDefinition(definition({ checks: [...oneCheck(), ...oneCheck()] }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.field === "the-check" && /Duplicate check id/.test(issue.message)));
});

test("validator: an unknown check kind is reported and stops that check", () => {
  const result = validateDefinition(definition({ checks: [{ id: "a", label: "A", kind: "file_teleport" }] }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /Unknown check kind "file_teleport"/.test(issue.message)));
  // The walk returns early for the unknown kind, so no noisy field errors follow.
  assert.ok(!has(result, "error", /needs the `/));

  const missingKind = validateDefinition(definition({ checks: [{ id: "a", label: "A" }] }));
  assert.ok(has(missingKind, "error", /Unknown check kind ""/));
});

test("validator: every advertised kind is recognised by isCheckKind", () => {
  for (const kind of CHECK_KINDS) assert.equal(isCheckKind(kind), true, `${kind} should be known`);
  assert.equal(isCheckKind("file_teleport"), false);
  assert.equal(isCheckKind(""), false);
});

/* -------------------------------------------------------------------------- */
/*  Checks: required fields                                                   */
/* -------------------------------------------------------------------------- */

test("validator: required fields are enforced, blanks and empty lists included", () => {
  const missingPattern = validateDefinition(
    definition({ checks: [{ id: "a", label: "A", kind: "file_contains", path: "/etc/hosts" }] }),
  );
  assert.ok(has(missingPattern, "error", /"file_contains" checks need the `pattern` field/));

  const blankMode = validateDefinition(
    definition({ checks: [{ id: "a", label: "A", kind: "file_mode", path: "/etc/hosts", mode: "   " }] }),
  );
  assert.ok(has(blankMode, "error", /"file_mode" checks need the `mode` field/));

  const noPatterns = validateDefinition(
    definition({ checks: [{ id: "a", label: "A", kind: "command_sequence", patterns: [] }] }),
  );
  assert.ok(has(noPatterns, "error", /"command_sequence" checks need the `patterns` field/));
});

test("validator: file_owner needs an owner or a group, not just a path", () => {
  // With neither field the check compares nothing and passes for any file that
  // happens to exist — the most common way to author a no-op check.
  const bare = validateDefinition(
    definition({ checks: [{ id: "own", label: "Ownership", kind: "file_owner", path: "/etc/hosts" }] }),
  );
  assert.equal(bare.ok, false);
  assert.ok(has(bare, "error", /"file_owner" checks need at least one of `owner` or `group`/));

  const withOwner = validateDefinition(
    definition({ checks: [{ id: "own", label: "Ownership", kind: "file_owner", path: "/etc/hosts", owner: "root" }] }),
  );
  assert.equal(withOwner.ok, true);
  assert.ok(!has(withOwner, "error", /at least one of/));

  const withGroup = validateDefinition(
    definition({ checks: [{ id: "own", label: "Ownership", kind: "file_owner", path: "/etc/hosts", group: "root" }] }),
  );
  assert.equal(withGroup.ok, true);
});

/* -------------------------------------------------------------------------- */
/*  Checks: points and regexes                                                */
/* -------------------------------------------------------------------------- */

test("validator: points must be a whole number of zero or more", () => {
  for (const points of [-1, 1.5, -0.5]) {
    const result = validateDefinition(definition({ checks: oneCheck({ points }) }));
    assert.equal(result.ok, false, `${points} should be rejected`);
    assert.ok(has(result, "error", /whole number of 0 or more/));
  }

  assert.equal(validateDefinition(definition({ checks: oneCheck({ points: 0 }) })).ok, true);
  assert.equal(validateDefinition(definition({ checks: oneCheck({ points: 2 }) })).ok, true);
});

test("validator: the point total treats a missing weight as one", () => {
  const result = validateDefinition(
    definition({
      checks: [
        { id: "a", label: "A", kind: "file_exists", path: "/nope-a", points: 3 },
        { id: "b", label: "B", kind: "file_exists", path: "/nope-b" },
      ],
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.totalPoints, 4);
});

test("validator: a pattern that will not compile is an error", () => {
  const badPattern = validateDefinition(
    definition({ checks: [{ id: "a", label: "A", kind: "file_contains", path: "/etc/hosts", pattern: "([" }] }),
  );
  assert.equal(badPattern.ok, false);
  assert.ok(has(badPattern, "error", /`pattern` is not a valid regular expression/));

  const badSubject = validateDefinition(
    definition({ checks: [{ id: "m", label: "Mail", kind: "mail_flagged", subjectPattern: "[" }] }),
  );
  assert.equal(badSubject.ok, false);
  assert.ok(has(badSubject, "error", /`subjectPattern` is not a valid regular expression/));

  const good = validateDefinition(
    definition({ checks: [{ id: "a", label: "A", kind: "file_contains", path: "/home/student/missing.txt", pattern: "^root:\\w+" }] }),
  );
  assert.equal(good.ok, true);
});

test("validator: a non-string `flags` is skipped rather than compiled", () => {
  const result = validateDefinition(
    definition({
      checks: [{ id: "a", label: "A", kind: "file_contains", path: "/home/student/missing.txt", pattern: "^a", flags: ["i"] }],
    }),
  );
  assert.equal(result.ok, true);
});

/* -------------------------------------------------------------------------- */
/*  Checks: cross-references become warnings                                  */
/* -------------------------------------------------------------------------- */

test("validator: a spreadsheet check names a document it can see", () => {
  const unknown = validateDefinition(
    definition({ checks: [{ id: "s", label: "S", kind: "sheet_exists", doc: "Missing.xlsx", sheet: "Sheet1" }] }),
  );
  assert.equal(unknown.ok, true);
  assert.ok(has(unknown, "warning", /not defined in `docs`/));

  const known = validateDefinition(
    definition({
      docs: [{ type: "document", name: "Report.docx", location: "/Documents", blocks: [], cursor: 0 }],
      checks: [{ id: "d", label: "D", kind: "doc_contains", doc: "Report.docx", pattern: "hello" }],
    }),
  );
  assert.equal(known.ok, true);
  assert.ok(!has(known, "warning", /not defined in `docs`/));
});

test("validator: a service check warns only when no such service can exist", () => {
  const missing = validateDefinition(
    definition({ checks: [{ id: "s", label: "S", kind: "service_state", name: "not-a-real-unit", active: true }] }),
  );
  assert.equal(missing.ok, true);
  assert.ok(has(missing, "warning", /can never pass/));

  // Declared in `state.services`, so the author clearly means it to exist.
  const declared = validateDefinition(
    definition({
      state: { services: [{ name: "custom-svc", active: false, enabled: false }] },
      checks: [{ id: "s", label: "S", kind: "service_state", name: "custom-svc", active: true }],
    }),
  );
  assert.ok(!has(declared, "warning", /can never pass/));

  // A unit the platform ships with is fine even though it is not declared.
  const fromDefaults = validateDefinition(
    definition({ checks: [{ id: "s", label: "S", kind: "service_state", name: "nginx", active: true }] }),
  );
  assert.ok(!has(fromDefaults, "warning", /can never pass/));
});

/* -------------------------------------------------------------------------- */
/*  Hints                                                                     */
/* -------------------------------------------------------------------------- */

test("validator: hint ids must be unique", () => {
  const result = validateDefinition(
    definition({ hints: [{ id: "h", text: "First" }, { id: "h", text: "Second" }] }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.field === "h" && /Duplicate hint id/.test(issue.message)));
});

/* -------------------------------------------------------------------------- */
/*  The dry run                                                               */
/* -------------------------------------------------------------------------- */

test("validator: a check that already passes at boot is flagged", () => {
  const result = validateDefinition(
    definition({ checks: [{ id: "exists", label: "Hosts exists", kind: "file_exists", path: "/etc/hosts" }] }),
  );
  assert.equal(result.ok, true);
  assert.ok(has(result, "warning", /already passes before the student does anything/));

  // A check that fails from the untouched state is exactly what we want.
  const fails = validateDefinition(definition({ checks: oneCheck() }));
  assert.equal(fails.ok, true);
  assert.ok(!has(fails, "warning", /already passes/));
});

test("validator: a scenario worth zero points is flagged", () => {
  const result = validateDefinition(definition({ checks: oneCheck({ points: 0 }) }));
  assert.equal(result.ok, true);
  assert.equal(result.totalPoints, 0);
  assert.ok(has(result, "warning", /worth zero points/));
});

test("validator: the dry run is skipped while errors remain", () => {
  // The check would pass at boot *and* has a duplicate id; the duplicate must be
  // the only complaint, so the author fixes errors before reading warnings.
  const result = validateDefinition(
    definition({ checks: [{ id: "dup", label: "Dup", kind: "file_exists", path: "/etc/hosts" }, ...oneCheck({ id: "dup" })] }),
  );
  assert.equal(result.ok, false);
  assert.ok(!has(result, "warning", /already passes/));
});
