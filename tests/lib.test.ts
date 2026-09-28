/**
 * Library tests.
 *
 * The simulator itself is covered in `sim.test.ts`. This file reaches the rest
 * of `src/lib` — the availability rule that decides what students may run, the
 * path/permission helpers that every driver builds on, the password primitives
 * and the small formatting helpers the UI leans on. All of it is pure, so none
 * of it needs a database or a browser.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  ALL_PLATFORMS_ENABLED,
  equipmentList,
  evaluatePackage,
  evaluateScenario,
  licenceExpired,
  platformLabel,
  type PackageForAvailability,
  type ScenarioWithSoftware,
} from "../src/lib/availability-rules";
import { ACCENT_COLORS, hashPassword, pickAccent, verifyPassword } from "../src/lib/auth-hash";
import {
  accentFor,
  cn,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatRelative,
  initials,
} from "../src/lib/cn";
import {
  assignmentTimeLimitSec,
  optionalId,
  parseDateInput,
  parseDateTimeInput,
  resolveUserEdit,
} from "../src/lib/form-rules";
import { parseAssignmentForm } from "../src/lib/assignment-rules";
import {
  allowSelfRegistration,
  joinOutcome,
  MIN_PASSWORD_LENGTH,
  normalizeJoinCode,
  passwordProblem,
  REGISTRATION,
  safeRelativePath,
} from "../src/lib/auth-rules";
import {
  isMaskedKey,
  parseSoftwareForm,
  resolveStoredKey,
  softwareSourceProblem,
} from "../src/lib/software-rules";
import { canDeleteScenario, parseScenarioMeta, slugify } from "../src/lib/scenario-rules";
import {
  percentile,
  summariseAttempts,
  summariseByScenario,
  summariseChecks,
  trendByDay,
  type AttemptRow,
  type CheckResultRow,
} from "../src/lib/analytics-rules";
import { interpolate, resolveLocale, translate } from "../src/lib/i18n";
import { en, messagesFor } from "../src/lib/locales";
import {
  buildAssurancePacket,
  buildCompletionRecord,
  certificateCode,
  verifyAssurancePacket,
  verifyCompletionRecord,
  type CompletionInput,
} from "../src/lib/credentials";
import type { ScenarioDefinition } from "../src/lib/sim/types";
import {
  baseName,
  canAccess,
  describeMode,
  dirName,
  display,
  formatMode,
  isGlob,
  joinPath,
  matchSegment,
  normalize,
  parseMode,
  segments,
  toKey,
} from "../src/lib/sim/paths";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

/** A fixed clock so licence tests never depend on the wall time. */
const NOW = Date.parse("2026-06-01T00:00:00Z");
const PAST = new Date("2026-05-01T00:00:00Z");
const FUTURE = new Date("2026-12-01T00:00:00Z");

function pkg(overrides: Partial<PackageForAvailability> = {}): PackageForAvailability {
  return {
    id: "pkg-1",
    name: "Contoso Suite",
    vendor: "Contoso",
    version: "1.0",
    platform: "LINUX",
    source: "INTERNAL",
    sourceUrl: null,
    uploadPath: null,
    licenseType: "OPEN",
    licenseKey: null,
    licenseExpiresAt: null,
    enabled: true,
    ...overrides,
  };
}

function scenario(overrides: Partial<ScenarioWithSoftware> = {}): ScenarioWithSoftware {
  return { id: "scenario-1", platform: "LINUX", published: true, software: [], ...overrides };
}

function kinds(blockers: { kind: string }[]): string[] {
  return blockers.map((blocker) => blocker.kind);
}

/* -------------------------------------------------------------------------- */
/*  Availability: a single package                                            */
/* -------------------------------------------------------------------------- */

test("availability: a healthy internal package has no complaints", () => {
  assert.deepEqual(evaluatePackage(pkg(), NOW), []);
});

test("availability: a disabled package blocks on its enable switch", () => {
  const blockers = evaluatePackage(pkg({ enabled: false }), NOW);
  assert.deepEqual(kinds(blockers), ["software-disabled"]);
  assert.match(blockers[0].message, /Contoso Suite is disabled/);
});

test("availability: an uploaded package needs its file on disk", () => {
  assert.deepEqual(kinds(evaluatePackage(pkg({ source: "UPLOAD" }), NOW)), ["software-source"]);
  assert.deepEqual(evaluatePackage(pkg({ source: "UPLOAD", uploadPath: "pkg/contoso.deb" }), NOW), []);
});

test("availability: a URL package needs its download URL", () => {
  assert.deepEqual(kinds(evaluatePackage(pkg({ source: "URL" }), NOW)), ["software-source"]);
  assert.deepEqual(evaluatePackage(pkg({ source: "URL", sourceUrl: "https://example.test/c.deb" }), NOW), []);
});

test("availability: a licensed package needs a stored key", () => {
  const missing = evaluatePackage(pkg({ licenseType: "LICENSED" }), NOW);
  assert.deepEqual(kinds(missing), ["license-key"]);
  assert.deepEqual(evaluatePackage(pkg({ licenseType: "LICENSED", licenseKey: "KEY-1" }), NOW), []);
});

test("availability: an expired licence blocks a licensed package", () => {
  const blockers = evaluatePackage(pkg({ licenseType: "LICENSED", licenseKey: "KEY-1", licenseExpiresAt: PAST }), NOW);
  assert.deepEqual(kinds(blockers), ["license-expired"]);
  assert.match(blockers[0].message, /license expired on 2026-05-01/);
});

test("availability: an evaluation build runs keyless until its window closes", () => {
  // No key, but still inside the trial window: perfectly usable.
  assert.deepEqual(evaluatePackage(pkg({ licenseType: "EVALUATION", licenseExpiresAt: FUTURE }), NOW), []);

  // Windows closed: the vendor build may no longer be handed out.
  const expired = evaluatePackage(pkg({ licenseType: "EVALUATION", licenseExpiresAt: PAST }), NOW);
  assert.deepEqual(kinds(expired), ["license-expired"]);
  assert.match(expired[0].message, /evaluation period ended on 2026-05-01/);
});

test("availability: OPEN software never expires, even with a stale date", () => {
  assert.equal(licenceExpired(pkg({ licenseExpiresAt: PAST }), NOW), false);
  assert.deepEqual(evaluatePackage(pkg({ licenseExpiresAt: PAST }), NOW), []);
});

test("availability: an evaluation build with no end date never lapses", () => {
  assert.deepEqual(evaluatePackage(pkg({ licenseType: "EVALUATION", licenseExpiresAt: null }), NOW), []);
  assert.equal(licenceExpired(pkg({ licenseType: "EVALUATION", licenseExpiresAt: null }), NOW), false);
});

test("availability: an expired evaluation complains only about time, never a key", () => {
  // Evaluation builds are keyless by design, so the *only* blocker once the
  // trial closes is the expiry — never a missing activation key.
  const blockers = evaluatePackage(pkg({ licenseType: "EVALUATION", licenseKey: null, licenseExpiresAt: PAST }), NOW);
  assert.deepEqual(kinds(blockers), ["license-expired"]);
  assert.match(blockers[0].message, /evaluation period ended on 2026-05-01/);
});

test("availability: a licensed package needs both a key and time on the clock", () => {
  // Missing key *and* expired: both are reported, key first.
  const both = evaluatePackage(pkg({ licenseType: "LICENSED", licenseKey: null, licenseExpiresAt: PAST }), NOW);
  assert.deepEqual(kinds(both), ["license-key", "license-expired"]);

  // A stored key but a future expiry is perfectly usable.
  assert.deepEqual(evaluatePackage(pkg({ licenseType: "LICENSED", licenseKey: "KEY-1", licenseExpiresAt: FUTURE }), NOW), []);
});

test("availability: a scenario gated by an expired evaluation is withheld", () => {
  const expired = pkg({ name: "Trial Tool", licenseType: "EVALUATION", licenseExpiresAt: PAST });
  const result = evaluateScenario(
    scenario({ software: [{ required: true, softwarePackage: expired }] }),
    ALL_PLATFORMS_ENABLED,
    NOW,
  );
  assert.equal(result.available, false);
  assert.deepEqual(kinds(result.blockers), ["license-expired"]);
  assert.match(result.blockers[0].message, /Trial Tool evaluation period ended on 2026-05-01/);
});

test("availability: every problem is reported, not just the first", () => {
  const blockers = evaluatePackage(
    pkg({ enabled: false, source: "URL", licenseType: "LICENSED", licenseExpiresAt: PAST }),
    NOW,
  );
  assert.deepEqual(kinds(blockers).sort(), ["license-expired", "license-key", "software-disabled", "software-source"]);
});

/* -------------------------------------------------------------------------- */
/*  Availability: a whole scenario                                            */
/* -------------------------------------------------------------------------- */

test("availability: a published scenario with healthy dependencies is offered", () => {
  const result = evaluateScenario(scenario({ software: [{ required: true, softwarePackage: pkg() }] }), ALL_PLATFORMS_ENABLED, NOW);
  assert.equal(result.available, true);
  assert.deepEqual(result.blockers, []);
});

test("availability: a switched-off platform blocks the scenario", () => {
  const result = evaluateScenario(scenario(), { disabledPlatforms: new Set(["LINUX"]) }, NOW);
  assert.equal(result.available, false);
  assert.deepEqual(kinds(result.blockers), ["platform"]);
  assert.match(result.blockers[0].message, /Linux simulations are currently switched off/);
});

test("availability: an unpublished scenario is not offered", () => {
  const result = evaluateScenario(scenario({ published: false }), ALL_PLATFORMS_ENABLED, NOW);
  assert.deepEqual(kinds(result.blockers), ["unpublished"]);
});

test("availability: only required dependencies gate the scenario", () => {
  const broken = pkg({ name: "Optional Plugin", enabled: false });

  const optional = evaluateScenario(
    scenario({ software: [{ required: false, softwarePackage: broken }] }),
    ALL_PLATFORMS_ENABLED,
    NOW,
  );
  assert.equal(optional.available, true);

  const required = evaluateScenario(
    scenario({ software: [{ required: true, softwarePackage: broken }] }),
    ALL_PLATFORMS_ENABLED,
    NOW,
  );
  assert.equal(required.available, false);
  assert.deepEqual(kinds(required.blockers), ["software-disabled"]);
});

test("availability: the equipment list annotates optional items too", () => {
  const list = equipmentList(
    scenario({
      software: [
        { required: true, softwarePackage: pkg({ id: "a", name: "Ready" }) },
        { required: false, softwarePackage: pkg({ id: "b", name: "Broken", enabled: false }) },
      ],
    }),
    NOW,
  );

  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((item) => ({ name: item.name, required: item.required, ready: item.ready })),
    [
      { name: "Ready", required: true, ready: true },
      { name: "Broken", required: false, ready: false },
    ],
  );
});

test("availability: platforms have friendly names", () => {
  assert.equal(platformLabel("LINUX"), "Linux");
  assert.equal(platformLabel("WINDOWS"), "Windows");
  assert.equal(platformLabel("OFFICE"), "Office");
});

/* -------------------------------------------------------------------------- */
/*  Paths and permissions                                                     */
/* -------------------------------------------------------------------------- */

test("paths: posix input resolves against the working directory", () => {
  assert.equal(normalize("LINUX", "/home/student", ".."), "/home");
  assert.equal(normalize("LINUX", "/home/student", "~/docs"), "/home/student/docs");
  assert.equal(normalize("LINUX", "/home/student", "/etc/nginx/../nginx/nginx.conf"), "/etc/nginx/nginx.conf");
  assert.equal(normalize("LINUX", "/home/student", ""), "/home/student");
});

test("paths: windows input keeps its drive and case", () => {
  assert.equal(normalize("WINDOWS", "/c:/Users/student", "C:\\Windows\\System32"), "/c:/Windows/System32");
  assert.equal(normalize("WINDOWS", "/c:/Users/student", "..\\.."), "/c:");
  assert.equal(display("WINDOWS", "/c:/Users/student"), "C:\\Users\\student");
  assert.equal(display("WINDOWS", "/c:/Windows/System32"), "C:\\Windows\\System32");
});

test("paths: lookups are case-insensitive only on Windows", () => {
  assert.equal(toKey("WINDOWS", "/c:/Users/Student"), "/c:/users/student");
  assert.equal(toKey("LINUX", "/Home/Student"), "/Home/Student");
});

test("paths: base, dir and segments split a canonical path", () => {
  assert.equal(baseName("/home/student/notes.txt"), "notes.txt");
  assert.equal(baseName("/"), "/");
  assert.deepEqual(segments("/a/b/c"), ["a", "b", "c"]);
  assert.equal(dirName("LINUX", "/a/b/c"), "/a/b");
  assert.equal(dirName("LINUX", "/"), "/");
  assert.equal(dirName("WINDOWS", "/c:/Windows/System32"), "/c:/Windows");
  assert.equal(dirName("WINDOWS", "/c:/Users"), "/c:");
});

test("paths: joining keeps a single separator", () => {
  assert.equal(joinPath("LINUX", "/etc", "nginx/nginx.conf"), "/etc/nginx/nginx.conf");
  assert.equal(joinPath("WINDOWS", "/c:", "Windows"), "/c:/Windows");
});

test("paths: mode strings parse in every form the console shows", () => {
  assert.equal(parseMode("644"), 0o644);
  assert.equal(parseMode("0755"), 0o755);
  assert.equal(parseMode("rw-r--r--"), 0o644);
  assert.equal(parseMode(0o600), 0o600);
  assert.equal(parseMode(undefined), 0o644);
  assert.equal(parseMode("nonsense"), 0o644);
  assert.equal(formatMode(0o755), "rwxr-xr-x");
  assert.equal(describeMode(0o600, "file"), "-rw-------");
  assert.equal(describeMode(0o755, "dir"), "drwxr-xr-x");
});

test("paths: access checks honour owner, group and root", () => {
  const owned = { mode: 0o640, owner: "alice" };
  assert.equal(canAccess(owned, "alice", "r"), true);
  assert.equal(canAccess(owned, "alice", "w"), true);
  assert.equal(canAccess(owned, "bob", "r"), false);
  assert.equal(canAccess(owned, "bob", "r", true), true); // group can read
  assert.equal(canAccess(owned, "bob", "w", true), false);
  assert.equal(canAccess(owned, "root", "w"), true);
});

test("paths: globs match a single segment", () => {
  assert.equal(isGlob("*.txt"), true);
  assert.equal(isGlob("notes.txt"), false);
  assert.equal(matchSegment("*.txt", "notes.txt", false), true);
  assert.equal(matchSegment("*.txt", "NOTES.TXT", false), false);
  assert.equal(matchSegment("*.txt", "NOTES.TXT", true), true);
  assert.equal(matchSegment("log?", "log1", false), true);
  assert.equal(matchSegment("log?", "log12", false), false);
});

/* -------------------------------------------------------------------------- */
/*  Password hashing                                                          */
/* -------------------------------------------------------------------------- */

test("auth: passwords round-trip through scrypt", async () => {
  const stored = await hashPassword("correct horse battery staple");
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  assert.equal(await verifyPassword("wrong password", stored), false);
});

test("auth: hashes are salted, so the same password stores differently", async () => {
  const first = await hashPassword("hunter2");
  const second = await hashPassword("hunter2");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("hunter2", second), true);
});

test("auth: malformed stored hashes are rejected rather than throwing", async () => {
  assert.equal(await verifyPassword("hunter2", ""), false);
  assert.equal(await verifyPassword("hunter2", "bcrypt$deadbeef$cafe"), false);
  assert.equal(await verifyPassword("hunter2", "scrypt$onlytwo"), false);
});

test("auth: accents are deterministic and drawn from the palette", () => {
  assert.equal(pickAccent("student@example.test"), pickAccent("student@example.test"));
  for (const seed of ["", "a", "Zed", "instructor@ontrak.local", "1234567890"]) {
    assert.ok((ACCENT_COLORS as readonly string[]).includes(pickAccent(seed)));
  }
});

/* -------------------------------------------------------------------------- */
/*  UI helpers                                                                */
/* -------------------------------------------------------------------------- */

test("cn: joins truthy values and flattens nested arrays", () => {
  assert.equal(cn("a", false, undefined, null, "", ["b", ["c"]]), "a b c");
  assert.equal(cn(0, "a"), "a");
  assert.equal(cn(), "");
});

test("cn: initials cope with one-word and empty names", () => {
  assert.equal(initials("Ada Lovelace"), "AL");
  assert.equal(initials("Grace Brewster Hopper"), "GH");
  assert.equal(initials("root"), "RO");
  assert.equal(initials("   "), "?");
});

test("cn: durations render as a clock", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(59), "0:59");
  assert.equal(formatDuration(60), "1:00");
  assert.equal(formatDuration(3661), "1:01:01");
  assert.equal(formatDuration(-5), "0:00");
  assert.equal(formatDuration(Number.NaN), "0:00");
});

test("cn: byte sizes pick a readable unit", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(null), "—");
  assert.equal(formatBytes(undefined), "—");
});

test("cn: relative and absolute timestamps are stable", () => {
  assert.equal(formatRelative(new Date()), "just now");
  assert.equal(formatRelative(new Date(Date.now() - 5 * 60_000)), "5 min ago");
  assert.equal(formatRelative(new Date(Date.now() - 3 * 3_600_000)), "3 h ago");
  assert.equal(formatDateTime(new Date("2026-01-02T03:04:05Z")), "2026-01-02 03:04");
});

test("cn: an unknown accent falls back to the brand colour", () => {
  assert.equal(accentFor("pink").text, "text-pink");
  assert.equal(accentFor("not-a-color").bg, accentFor("violet").bg);
});

/* -------------------------------------------------------------------------- */
/*  Form rules                                                                */
/* -------------------------------------------------------------------------- */

test("forms: an assignment override in minutes becomes seconds", () => {
  assert.equal(assignmentTimeLimitSec("30"), 30 * 60);
  assert.equal(assignmentTimeLimitSec("1"), 60);
  assert.equal(assignmentTimeLimitSec(2.5), 150);
  assert.equal(assignmentTimeLimitSec(" 45 "), 45 * 60);
});

test("forms: a blank or non-positive override means \"no limit\"", () => {
  assert.equal(assignmentTimeLimitSec(""), null);
  assert.equal(assignmentTimeLimitSec("0"), null);
  assert.equal(assignmentTimeLimitSec("-5"), null);
  assert.equal(assignmentTimeLimitSec("soon"), null);
  assert.equal(assignmentTimeLimitSec(null), null);
  assert.equal(assignmentTimeLimitSec(undefined), null);
  assert.equal(assignmentTimeLimitSec(Number.NaN), null);
  assert.equal(assignmentTimeLimitSec(Number.POSITIVE_INFINITY), null);
});

test("forms: a date input is stored as the end of that day", () => {
  const deadline = parseDateInput("2026-09-26");
  assert.equal(deadline.ok, true);
  assert.ok(deadline.ok && deadline.date);
  assert.equal(deadline.ok ? deadline.date?.toISOString() : null, "2026-09-26T23:59:59.999Z");
});

test("forms: a blank date is \"no date\", not an error", () => {
  assert.deepEqual(parseDateInput(""), { ok: true, date: null });
  assert.deepEqual(parseDateInput(null), { ok: true, date: null });
  assert.deepEqual(parseDateInput("   "), { ok: true, date: null });
});

test("forms: an impossible date is an error, never an Invalid Date", () => {
  for (const bad of ["26/09/2026", "2026-02-31", "2026-13-01", "2026-00-10", "2026-09-00"]) {
    const result = parseDateInput(bad);
    assert.equal(result.ok, false, `${bad} should be rejected`);
  }
});

test("forms: a datetime-local value is read as UTC so deadlines do not drift", () => {
  const deadline = parseDateTimeInput("2026-09-26T14:30");
  assert.equal(deadline.ok, true);
  assert.equal(deadline.ok ? deadline.date?.toISOString() : null, "2026-09-26T14:30:00.000Z");

  const withSeconds = parseDateTimeInput("2026-09-26T14:30:15");
  assert.equal(withSeconds.ok ? withSeconds.date?.toISOString() : null, "2026-09-26T14:30:15.000Z");
});

test("forms: a blank or malformed datetime is handled without throwing", () => {
  assert.deepEqual(parseDateTimeInput(""), { ok: true, date: null });
  const bad = parseDateTimeInput("2026-09-26 14:30"); // missing the T separator
  assert.equal(bad.ok, false);
  const rolled = parseDateTimeInput("2026-09-26T25:00"); // hour 25 would roll over
  assert.equal(rolled.ok, false);
});

test("users: an administrator self-edit keeps the disabled fields unchanged", () => {
  // The role select and active checkbox are disabled on your own row, so the
  // form submits neither. The current values must survive the round trip.
  const result = resolveUserEdit({
    isSelf: true,
    requestedRole: "",
    validRoles: ["ADMIN", "INSTRUCTOR", "STUDENT"],
    activeField: null,
    currentRole: "ADMIN",
    currentActive: true,
  });
  assert.deepEqual(result, { role: "ADMIN", active: true });
});

test("users: an administrator cannot strip their own admin access", () => {
  const demote = resolveUserEdit({
    isSelf: true,
    requestedRole: "STUDENT",
    validRoles: ["ADMIN", "INSTRUCTOR", "STUDENT"],
    activeField: "on",
    currentRole: "ADMIN",
    currentActive: true,
  });
  assert.match(demote.error ?? "", /own administrator access/);

  const deactivate = resolveUserEdit({
    isSelf: true,
    requestedRole: "ADMIN",
    validRoles: ["ADMIN", "INSTRUCTOR", "STUDENT"],
    activeField: null,
    currentRole: "ADMIN",
    currentActive: true,
  });
  assert.equal(deactivate.active, true);
  assert.equal(deactivate.error, undefined);
});

test("users: editing someone else reads the submitted role and checkbox", () => {
  const promoted = resolveUserEdit({
    isSelf: false,
    requestedRole: "INSTRUCTOR",
    validRoles: ["ADMIN", "INSTRUCTOR", "STUDENT"],
    activeField: "on",
    currentRole: "STUDENT",
    currentActive: false,
  });
  assert.deepEqual(promoted, { role: "INSTRUCTOR", active: true });

  const cleared = resolveUserEdit({
    isSelf: false,
    requestedRole: "STUDENT",
    validRoles: ["ADMIN", "INSTRUCTOR", "STUDENT"],
    activeField: null,
    currentRole: "STUDENT",
    currentActive: true,
  });
  assert.deepEqual(cleared, { role: "STUDENT", active: false });

  const bogusRole = resolveUserEdit({
    isSelf: false,
    requestedRole: "SUPERUSER",
    validRoles: ["ADMIN", "INSTRUCTOR", "STUDENT"],
    activeField: "true",
    currentRole: "STUDENT",
    currentActive: false,
  });
  assert.deepEqual(bogusRole, { role: "STUDENT", active: true });
});

/* -------------------------------------------------------------------------- */
/*  Flow round-trips                                                          */
/*                                                                            */
/*  These tie a form rule to the model it feeds, so the two flows that were   */
/*  fixed — the assignment time limit and the licence expiry — are verified   */
/*  end to end in the only environment the suite can run in.                  */
/* -------------------------------------------------------------------------- */

test("flow: an assignment limit survives the minutes → seconds → minutes round trip", () => {
  for (const minutes of [1, 30, 90, 480]) {
    const stored = assignmentTimeLimitSec(String(minutes));
    assert.equal(stored, minutes * 60);
    // The list view renders `Math.round(timeLimitSec / 60) min`, so it must
    // read back as exactly what the instructor typed.
    assert.equal(Math.round((stored as number) / 60), minutes);
  }
});

test("flow: a licence expiry typed as a date lapses at the end of that date", () => {
  const parsed = parseDateInput("2026-05-01");
  assert.equal(parsed.ok, true);
  const expiry = parsed.ok ? parsed.date : null;
  assert.ok(expiry);
  const at = expiry as Date;

  const licensed = pkg({ licenseType: "LICENSED", licenseKey: "KEY-1", licenseExpiresAt: at });
  // A minute before midnight UTC on the day the admin typed: still usable.
  assert.deepEqual(evaluatePackage(licensed, at.getTime() - 60_000), []);
  // A minute after: blocked, and the message repeats the date they entered.
  const blockers = evaluatePackage(licensed, at.getTime() + 60_000);
  assert.deepEqual(kinds(blockers), ["license-expired"]);
  assert.match(blockers[0].message, /license expired on 2026-05-01/);
});

/* -------------------------------------------------------------------------- */
/*  The new-assignment form                                                   */
/* -------------------------------------------------------------------------- */

/** Build the FormData a browser would post from the assignment form. */
function assignmentForm(fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("scenarioId", "scenario-1");
  form.set("cohortId", "cohort-1");
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

test("assignment form: a scenario and a target are required", () => {
  const noScenario = parseAssignmentForm(new FormData());
  assert.equal(noScenario.ok, false);
  assert.match(noScenario.ok ? "" : noScenario.reason, /Choose a scenario/);

  const noTarget = parseAssignmentForm(assignmentForm({ cohortId: "" }));
  assert.equal(noTarget.ok, false);
  assert.match(noTarget.ok ? "" : noTarget.reason, /Pick a class or a student/);
 
  // A whitespace-only scenario id is not a scenario.
  const blankScenario = parseAssignmentForm(assignmentForm({ scenarioId: "   " }));
  assert.equal(blankScenario.ok, false);
});

test("assignment form: blank overrides fall back to the scenario", () => {
  const result = parseAssignmentForm(assignmentForm());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.draft, {
    scenarioId: "scenario-1",
    cohortId: "cohort-1",
    studentId: null,
    dueAt: null,
    timeLimitSec: null,
    maxAttempts: 0,
    instructions: null,
  });
});

test("assignment form: each field is read in the unit the action stores", () => {
  const result = parseAssignmentForm(
    assignmentForm({
      timeLimitMinutes: "30",
      maxAttempts: "2.9",
      dueAt: "2026-09-26T14:30",
      instructions: "  focus on the firewall  ",
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.draft.timeLimitSec, 30 * 60);
  assert.equal(result.draft.maxAttempts, 2);
  assert.equal(result.draft.dueAt?.toISOString(), "2026-09-26T14:30:00.000Z");
  assert.equal(result.draft.instructions, "focus on the firewall");
});

test("assignment form: a negative attempt cap is clamped, not stored", () => {
  const result = parseAssignmentForm(assignmentForm({ maxAttempts: "-3" }));
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.draft.maxAttempts : -1, 0);
});

test("assignment form: a malformed deadline is rejected", () => {
  const result = parseAssignmentForm(assignmentForm({ dueAt: "next tuesday" }));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /valid date and time/);
});

test("assignment form: a single student can be targeted without a class", () => {
  const result = parseAssignmentForm(assignmentForm({ cohortId: "", studentId: "student-9" }));
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.draft.cohortId : "x", null);
  assert.equal(result.ok ? result.draft.studentId : "", "student-9");
});

test("ids: a blank optional id is absent, not an empty string", () => {
  assert.equal(optionalId(""), null);
  assert.equal(optionalId("   "), null);
  assert.equal(optionalId(null), null);
  assert.equal(optionalId(undefined), null);
  assert.equal(optionalId("  abc  "), "abc");
});

/* -------------------------------------------------------------------------- */
/*  Registration + join codes                                                 */
/* -------------------------------------------------------------------------- */

test("register: a valid sign-up normalises its email and accepts a join code", () => {
  const parsed = REGISTRATION.safeParse({
    name: "Ada Lovelace",
    email: "  ADA@EXAMPLE.TEST ",
    password: "supersecret",
    joinCode: " ab12cd ",
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.email, "ada@example.test");
  assert.equal(parsed.data.joinCode, "ab12cd");
  // The roster lookup uses the normalised (upper-cased) form.
  assert.equal(normalizeJoinCode(parsed.data.joinCode), "AB12CD");
});

test("register: bad email, short password and short name are rejected", () => {
  const cases: Record<string, string>[] = [
    { name: "Ada Lovelace", email: "not-an-email", password: "supersecret" },
    { name: "Ada Lovelace", email: "ada@example.test", password: "short" },
    { name: "A", email: "ada@example.test", password: "supersecret" },
  ];
  for (const fields of cases) {
    assert.equal(REGISTRATION.safeParse(fields).success, false);
  }
});

test("join codes: trimmed and upper-cased, blank means no lookup", () => {
  assert.equal(normalizeJoinCode(" ab12cd "), "AB12CD");
  assert.equal(normalizeJoinCode("alreadyUP"), "ALREADYUP");
  assert.equal(normalizeJoinCode(""), null);
  assert.equal(normalizeJoinCode("   "), null);
  assert.equal(normalizeJoinCode(null), null);
  assert.equal(normalizeJoinCode(undefined), null);
});

test("redirect guard: only same-site relative paths survive", () => {
  assert.equal(safeRelativePath("/student"), "/student");
  assert.equal(safeRelativePath("/student?flash=hi"), "/student?flash=hi");
  assert.equal(safeRelativePath("//evil.test"), null);
  assert.equal(safeRelativePath("https://evil.test"), null);
  assert.equal(safeRelativePath("student"), null);
  assert.equal(safeRelativePath(null), null);
});

test("password policy: one rule for sign-up and the admin forms", () => {
  assert.equal(passwordProblem("1234567"), "Use a password of at least 8 characters.");
  assert.equal(passwordProblem(""), "Use a password of at least 8 characters.");
  assert.equal(passwordProblem("a".repeat(MIN_PASSWORD_LENGTH)), null);
  assert.equal(passwordProblem("a".repeat(64)), null);
});

test("register: the password boundary matches the shared policy", () => {
  const signUpWith = (password: string) =>
    REGISTRATION.safeParse({ name: "Ada Lovelace", email: "ada@example.test", password });
  assert.equal(signUpWith("a".repeat(MIN_PASSWORD_LENGTH - 1)).success, false);
  assert.equal(signUpWith("a".repeat(MIN_PASSWORD_LENGTH)).success, true);
});

test("join codes: the outcome distinguishes none, joined and unknown", () => {
  assert.deepEqual(joinOutcome("", true), { kind: "none" });
  assert.deepEqual(joinOutcome(null, false), { kind: "none" });
  assert.deepEqual(joinOutcome(" net101 ", true), { kind: "join", code: "NET101" });

  const unknown = joinOutcome("nope", false);
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.kind === "unknown" ? unknown.code : "", "NOPE");
  assert.match(unknown.kind === "unknown" ? unknown.message : "", /wasn't recognised/);
});

test("register: self-registration defaults on and can be switched off", () => {
  const previous = process.env.NEXT_PUBLIC_ALLOW_SELF_REGISTRATION;
  try {
    delete process.env.NEXT_PUBLIC_ALLOW_SELF_REGISTRATION;
    assert.equal(allowSelfRegistration(), true);
    process.env.NEXT_PUBLIC_ALLOW_SELF_REGISTRATION = "false";
    assert.equal(allowSelfRegistration(), false);
    process.env.NEXT_PUBLIC_ALLOW_SELF_REGISTRATION = "true";
    assert.equal(allowSelfRegistration(), true);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_ALLOW_SELF_REGISTRATION;
    else process.env.NEXT_PUBLIC_ALLOW_SELF_REGISTRATION = previous;
  }
});

/* -------------------------------------------------------------------------- */
/*  The software inventory form                                               */
/* -------------------------------------------------------------------------- */

function softwareForm(fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("name", "Contoso Suite");
  form.set("platform", "WINDOWS");
  form.set("source", "URL");
  form.set("licenseType", "LICENSED");
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

test("software form: a licensed package requires a key", () => {
  const result = parseSoftwareForm(softwareForm());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fields.platform, "WINDOWS");
  assert.equal(result.fields.source, "URL");
  assert.equal(result.fields.licenseType, "LICENSED");
  assert.equal(result.fields.requiresKey, true);
});

test("software form: an evaluation build never requires a key", () => {
  const result = parseSoftwareForm(softwareForm({ licenseType: "EVALUATION" }));
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.fields.requiresKey : true, false);
});

test("software form: unknown enum values fall back to the safe defaults", () => {
  const result = parseSoftwareForm(
    softwareForm({ platform: "SOLARIS", source: "MAGIC", licenseType: "PIRATE" }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fields.platform, "LINUX");
  assert.equal(result.fields.source, "INTERNAL");
  assert.equal(result.fields.licenseType, "OPEN");
  assert.equal(result.fields.requiresKey, false);
});

test("software key: a masked field keeps the stored key, anything else replaces it", () => {
  assert.equal(resolveStoredKey("••••••", "REAL-KEY"), "REAL-KEY");
  assert.equal(resolveStoredKey("KEY-NEW", "REAL-KEY"), "KEY-NEW");
  assert.equal(resolveStoredKey(null, "REAL-KEY"), null);
  assert.equal(resolveStoredKey("", "REAL-KEY"), "");
  assert.equal(resolveStoredKey("••••", null), null);
});

test("software source: URL needs a link and UPLOAD needs a file", () => {
  // Shared by the create and update actions, so a package can never be saved
  // in a state availability would immediately withhold.
  assert.match(softwareSourceProblem("URL", null, false) ?? "", /download URL is required/);
  assert.equal(softwareSourceProblem("URL", "https://example.test/c.deb", false), null);

  assert.match(softwareSourceProblem("UPLOAD", null, false) ?? "", /Choose a file to upload/);
  assert.equal(softwareSourceProblem("UPLOAD", null, true), null);

  assert.equal(softwareSourceProblem("INTERNAL", null, false), null);
});

test("software form: seats must be a positive whole number", () => {
  const seats = (value: string) => {
    const result = parseSoftwareForm(softwareForm({ licenseSeats: value }));
    return result.ok ? result.fields.licenseSeats : NaN;
  };
  assert.equal(seats("20"), 20);
  assert.equal(seats("12.7"), 12);
  assert.equal(seats("0"), null);
  assert.equal(seats("-3"), null);
  assert.equal(seats("nonsense"), null);
});

test("software form: the enabled checkbox accepts on/true or nothing", () => {
  const enabled = (value?: string) => {
    const form = softwareForm();
    if (value !== undefined) form.set("enabled", value);
    const result = parseSoftwareForm(form);
    return result.ok ? result.fields.enabled : false;
  };
  assert.equal(enabled(), false);
  assert.equal(enabled("on"), true);
  assert.equal(enabled("true"), true);
});

test("software form: an expiry is stored as the end of the day, bad ones rejected", () => {
  const good = parseSoftwareForm(softwareForm({ licenseExpiresAt: "2027-01-02" }));
  assert.equal(good.ok, true);
  assert.equal(good.ok ? good.fields.licenseExpiresAt?.toISOString() : null, "2027-01-02T23:59:59.999Z");

  const bad = parseSoftwareForm(softwareForm({ licenseExpiresAt: "2027-02-31" }));
  assert.equal(bad.ok, false);
});

test("software form: a masked key is recognised so the stored key is preserved", () => {
  assert.equal(isMaskedKey("abcd••••efgh"), true);
  assert.equal(isMaskedKey("ABC-1234-5678"), false);
  assert.equal(isMaskedKey(""), false);
  assert.equal(isMaskedKey(null), false);
});

/* -------------------------------------------------------------------------- */
/*  The scenario catalog form                                                 */
/* -------------------------------------------------------------------------- */

function scenarioDefinition(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    version: 1,
    platform: "LINUX",
    engine: "bash",
    objective: "Fix the broken web server",
    brief: "The web server will not start for students.",
    tasks: ["Start nginx"],
    machine: { hostname: "web01", user: "student", os: "Ubuntu", version: "24.04", arch: "x64" },
    checks: [],
    ...overrides,
  };
}

function scenarioForm(fields: Record<string, string | string[]> = {}): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const item of value) form.append(key, item);
    else form.set(key, value);
  }
  return form;
}

test("scenario form: an empty form falls back to the definition's copy", () => {
  const meta = parseScenarioMeta(scenarioForm(), scenarioDefinition());
  assert.equal(meta.title, "Fix the broken web server");
  assert.equal(meta.slugBase, "fix-the-broken-web-server");
  assert.equal(meta.summary, "Fix the broken web server");
  assert.equal(meta.description, "The web server will not start for students.");
  assert.equal(meta.difficulty, "INTERMEDIATE");
  assert.equal(meta.timeLimitSec, 1800);
  assert.equal(meta.passScore, 70);
  assert.equal(meta.published, false);
  assert.deepEqual(meta.tags, []);
  assert.deepEqual(meta.softwareIds, []);
});

test("scenario form: an untitled definition still gets a name", () => {
  const meta = parseScenarioMeta(scenarioForm(), scenarioDefinition({ objective: "" }));
  assert.equal(meta.title, "Untitled scenario");
});

test("scenario form: the time limit is clamped to 1 minute … 8 hours", () => {
  const limit = (value: string) => parseScenarioMeta(scenarioForm({ timeLimitSec: value }), scenarioDefinition()).timeLimitSec;
  assert.equal(limit("2400"), 2400);
  assert.equal(limit("30"), 60);
  assert.equal(limit("999999"), 60 * 60 * 8);
  assert.equal(limit("0"), 1800); // 0 means "use the default"
  assert.equal(limit("nonsense"), 1800);
});

test("scenario form: the pass score is clamped to 0 … 100", () => {
  const pass = (value: string) => parseScenarioMeta(scenarioForm({ passScore: value }), scenarioDefinition()).passScore;
  assert.equal(pass("80"), 80);
  assert.equal(pass("150"), 100);
  assert.equal(pass("-5"), 0);
  assert.equal(pass("nonsense"), 70);
});

test("scenario form: an unknown difficulty falls back to intermediate", () => {
  assert.equal(parseScenarioMeta(scenarioForm({ difficulty: "EXPERT" }), scenarioDefinition()).difficulty, "EXPERT");
  assert.equal(
    parseScenarioMeta(scenarioForm({ difficulty: "WIZARD" }), scenarioDefinition()).difficulty,
    "INTERMEDIATE",
  );
});

test("scenario form: tags are split, trimmed and de-blanked", () => {
  const meta = parseScenarioMeta(scenarioForm({ tags: " networking, linux ,,  dns " }), scenarioDefinition());
  assert.deepEqual(meta.tags, ["networking", "linux", "dns"]);
});

test("scenario form: publishing, explicit copy and software links are read", () => {
  const meta = parseScenarioMeta(
    scenarioForm({
      title: "  Custom Title ",
      slug: "custom-slug",
      published: "on",
      softwareIds: ["pkg-a", "pkg-b", ""],
    }),
    scenarioDefinition(),
  );
  assert.equal(meta.title, "Custom Title");
  assert.equal(meta.slugBase, "custom-slug");
  assert.equal(meta.published, true);
  assert.deepEqual(meta.softwareIds, ["pkg-a", "pkg-b"]);
});

test("scenario slugs: lower-cased, dashed and bounded", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("  --Foo__Bar--  "), "foo-bar");
  assert.equal(slugify(""), "");
  assert.equal(slugify("A".repeat(120)).length, 60);
});

test("scenarios are shared: staff can delete ones nobody has attempted", () => {
  assert.equal(canDeleteScenario("INSTRUCTOR", 0), true);
  assert.equal(canDeleteScenario("ADMIN", 0), true);
  assert.equal(canDeleteScenario("STUDENT", 0), false);
});

test("delete guard: a scenario with recorded attempts needs an administrator", () => {
  assert.equal(canDeleteScenario("INSTRUCTOR", 3), false);
  assert.equal(canDeleteScenario("ADMIN", 3), true);
});

/* -------------------------------------------------------------------------- */
/*  Instructor analytics                                                      */
/* -------------------------------------------------------------------------- */

function attemptRow(overrides: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: "a1",
    scenarioId: "s1",
    status: "GRADED",
    startedAt: new Date("2026-09-20T10:00:00.000Z"),
    submittedAt: new Date("2026-09-20T10:30:00.000Z"),
    timeSpentSec: 1800,
    score: 8,
    maxScore: 10,
    ...overrides,
  };
}

function checkRow(checkId: string, label: string, passed: boolean): CheckResultRow {
  return { checkId, label, passed };
}

test("analytics: percentile uses the nearest rank and handles empty input", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 90), 4);
  assert.equal(percentile([5], 100), 5);
});

test("analytics: checks are grouped and hardest come first", () => {
  const stats = summariseChecks([
    checkRow("c1", "Enable service", true),
    checkRow("c1", "Enable service", false),
    checkRow("c2", "Open firewall", false),
    checkRow("c2", "Open firewall", false),
  ]);
  assert.deepEqual(
    stats.map((stat) => ({ id: stat.checkId, rate: stat.passRate })),
    [
      { id: "c2", rate: 0 },
      { id: "c1", rate: 50 },
    ],
  );
  assert.equal(stats[1].attempts, 2);
  assert.equal(stats[1].passed, 1);
});

test("analytics: attempt stats summarise time, score and pass rate", () => {
  const stat = summariseAttempts(
    [
      attemptRow({ id: "a", score: 9, maxScore: 10, timeSpentSec: 100 }),
      attemptRow({ id: "b", score: 7, maxScore: 10, timeSpentSec: 300 }),
      attemptRow({ id: "c", score: 5, maxScore: 10, timeSpentSec: 0 }),
    ],
    { s1: 80 },
  );
  assert.equal(stat.attempts, 3);
  assert.equal(stat.averagePercent, 70); // (90 + 70 + 50) / 3
  assert.equal(stat.medianTimeSec, 100); // times >0: [100, 300]
  assert.equal(stat.p90TimeSec, 300);
  assert.equal(stat.passed, 1); // only 90% clears the 80% mark
  assert.equal(stat.passRate, 33);
  assert.equal(stat.passMark, 80); // the bar these attempts were judged against
});

test("analytics: the pass mark is the mean of the scenarios in play", () => {
  const stat = summariseAttempts(
    [
      attemptRow({ id: "a", scenarioId: "s1", score: 8, maxScore: 10 }), // 80% < 90 mark
      attemptRow({ id: "b", scenarioId: "s2", score: 9, maxScore: 10 }), // 90% ≥ 60 mark
      attemptRow({ id: "c", scenarioId: "s2", score: 7, maxScore: 10 }), // 70% ≥ 60 mark
    ],
    { s1: 90, s2: 60 },
  );
  assert.equal(stat.passMark, 70); // (90 + 60 + 60) / 3
  assert.equal(stat.passed, 2);
  assert.equal(stat.passRate, 67);

  // With no rows there is nothing to judge, so the default bar stands in.
  assert.equal(summariseAttempts([], {}).passMark, 70);
});

test("analytics: per-scenario rollup is busiest first", () => {
  const stats = summariseByScenario(
    [
      attemptRow({ id: "a", scenarioId: "s1" }),
      attemptRow({ id: "b", scenarioId: "s2", score: 10, maxScore: 10 }),
      attemptRow({ id: "c", scenarioId: "s2" }),
    ],
    {},
  );
  assert.deepEqual(stats.map((s) => s.scenarioId), ["s2", "s1"]);
  assert.equal(stats[0].attempts, 2);
  assert.equal(stats[0].averagePercent, 90);
  // Each row carries its own pass mark, so the UI need not assume 70.
  assert.equal(stats[0].passScore, 70);
});

test("analytics: per-scenario rows keep the scenario's own pass mark", () => {
  const stats = summariseByScenario(
    [attemptRow({ id: "a", scenarioId: "s1" }), attemptRow({ id: "b", scenarioId: "s2" })],
    { s1: 55, s2: 85 },
  );
  const marks = Object.fromEntries(stats.map((stat) => [stat.scenarioId, stat.passScore]));
  assert.deepEqual(marks, { s1: 55, s2: 85 });
});

test("analytics: the daily trend fills gaps and ignores older rows", () => {
  const now = new Date("2026-09-26T12:00:00.000Z");
  const trend = trendByDay(
    [
      attemptRow({ id: "old", submittedAt: new Date("2026-09-10T00:00:00.000Z") }),
      attemptRow({ id: "d24", submittedAt: new Date("2026-09-24T09:00:00.000Z"), score: 8, maxScore: 10 }),
      attemptRow({ id: "d26a", submittedAt: new Date("2026-09-26T09:00:00.000Z"), score: 8, maxScore: 10 }),
      attemptRow({ id: "d26b", submittedAt: new Date("2026-09-26T11:00:00.000Z"), score: 5, maxScore: 10 }),
    ],
    3,
    now,
  );
  assert.deepEqual(trend.map((b) => b.date), ["2026-09-24", "2026-09-25", "2026-09-26"]);
  assert.deepEqual(trend.map((b) => b.attempts), [1, 0, 2]);
  assert.deepEqual(trend.map((b) => b.averagePercent), [80, 0, 65]);
});

/* -------------------------------------------------------------------------- */
/*  Internationalisation                                                      */
/* -------------------------------------------------------------------------- */

test("i18n: locale resolution falls back to English", () => {
  assert.equal(resolveLocale("es"), "es");
  assert.equal(resolveLocale("en"), "en");
  assert.equal(resolveLocale("fr"), "en");
  assert.equal(resolveLocale(undefined), "en");
  assert.equal(resolveLocale(null), "en");
});

test("i18n: interpolation fills known keys and leaves unknown ones visible", () => {
  assert.equal(interpolate("Hi {name}, {n} left", { name: "Ada", n: 2 }), "Hi Ada, 2 left");
  assert.equal(interpolate("No vars {x}"), "No vars {x}");
  assert.equal(interpolate("Missing {y}", { z: 1 }), "Missing {y}");
});

test("i18n: translate resolves a key and echoes a missing one", () => {
  const messages = messagesFor("en");
  assert.equal(translate(messages, "nav.overview"), "Overview");
  assert.equal(translate(messages, "does.not.exist"), "does.not.exist");
  assert.equal(translate(messagesFor("es"), "nav.overview"), "Resumen");
});

test("i18n: every locale defines exactly the English key set", () => {
  const englishKeys = Object.keys(en).sort();
  assert.deepEqual(Object.keys(messagesFor("es")).sort(), englishKeys);
});

/* -------------------------------------------------------------------------- */
/*  Completion records & assurance packets                                    */
/* -------------------------------------------------------------------------- */

const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

function completion(overrides: Partial<CompletionInput> = {}): CompletionInput {
  return {
    learnerId: "u1",
    learnerName: "Ada Lovelace",
    scenarioId: "s1",
    scenarioTitle: "Fix the web server",
    platform: "LINUX",
    passed: true,
    score: 9,
    maxScore: 10,
    percent: 90,
    skills: ["networking"],
    completedAt: "2026-09-26T10:00:00.000Z",
    issuer: "Innotel Labs",
    ...overrides,
  };
}

test("credentials: a record is deterministic and self-verifying", () => {
  const a = buildCompletionRecord(completion(), sha256);
  const b = buildCompletionRecord(completion(), sha256);
  assert.equal(a.digest, b.digest);
  assert.equal(a.id, b.id);
  assert.match(a.id, /^crt_[0-9a-f]{16}$/);
  assert.equal(verifyCompletionRecord(a, sha256), true);
});

test("credentials: editing a record invalidates it", () => {
  const record = buildCompletionRecord(completion(), sha256);
  const tampered = { ...record, percent: 100 };
  assert.equal(verifyCompletionRecord(tampered, sha256), false);
});

test("credentials: certificate codes are short and digest-derived", () => {
  const record = buildCompletionRecord(completion(), sha256);
  assert.match(certificateCode(record), /^ONTRAK-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
});

test("credentials: an assurance packet verifies and detects tampering", () => {
  const records = [
    buildCompletionRecord(completion(), sha256),
    buildCompletionRecord(completion({ learnerId: "u2", learnerName: "Grace Hopper" }), sha256),
  ];
  const packet = buildAssurancePacket(records, "Innotel Labs", "2026-09-27T00:00:00.000Z", sha256);
  assert.equal(verifyAssurancePacket(packet, sha256), true);

  const edited = { ...packet, records: [{ ...packet.records[0], passed: false }, packet.records[1]] };
  assert.equal(verifyAssurancePacket(edited, sha256), false);

  const shortened = { ...packet, records: [packet.records[0]] };
  assert.equal(verifyAssurancePacket(shortened, sha256), false);
});
