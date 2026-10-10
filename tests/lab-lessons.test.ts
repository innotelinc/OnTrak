/**
 * Lessons: the walkthroughs a scenario points a student at.
 *
 * Two things are worth testing beyond "does it load": that the *shipped* library
 * validates (a lesson with no exercises is a read-through, and a scenario that links a
 * lesson which does not exist sends a student to a 404 mid-ticket), and that the
 * validator actually rejects a broken lesson rather than shrugging.
 *
 * The data here is the real one: the lab's own `lessons/*.yaml`, converted field for
 * field into `src/lib/lab/data/lessons.json`. So a rejection of a shipped lesson means
 * the port is wrong, not the lesson — which is the same thing the Python suite asserted
 * against the same seven lessons.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-lessons.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  LessonError,
  LessonRepository,
  lessonAllShell,
  lessonPublicView,
  parseLessonRecord,
  type LessonManifests,
} from "../src/lib/lab/lessons";
import type { LessonFacts } from "../src/lib/lab/scenarios";

const DATA = path.join(process.cwd(), "src", "lib", "lab", "data", "lessons.json");

/** The shipped library, as the deployment ships it. */
function shipped(): LessonManifests {
  return JSON.parse(readFileSync(DATA, "utf8")) as LessonManifests;
}

function repository(manifests: LessonManifests = shipped()): LessonRepository {
  return new LessonRepository(manifests);
}

/** One lesson that is valid except for whatever a test overrides. */
function lesson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "unit-lesson",
    title: "A unit lesson",
    platform: "linux",
    summary: "One sentence for the list.",
    commands: [{ command: "ls -l", what: "list in long form" }],
    exercises: [{ id: "one", prompt: "do it", solution: "ls -l" }],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  The shipped library                                                       */
/* -------------------------------------------------------------------------- */

test("lessons: the shipped library validates", () => {
  const lessons = repository();
  // Not "no problems found so far": the validator walks every lesson, and the count is
  // asserted separately so a bundle that loaded nothing cannot look healthy.
  assert.deepEqual(lessons.validate(), []);
  assert.ok(lessons.list().length >= 5, `only ${lessons.list().length} lessons loaded`);
});

test("lessons: Linux and Windows are both taught", () => {
  const platforms = new Set(repository().list().map((entry) => entry.platform));
  assert.ok(platforms.has("linux"), "a Linux lesson ships");
  assert.ok(platforms.has("windows"), "a Windows lesson ships");
});

test("lessons: every lesson has something to teach and something to practise", () => {
  for (const entry of repository().list()) {
    assert.ok(entry.commands.length > 0 || entry.steps.length > 0, `${entry.id} teaches nothing`);
    assert.ok(entry.exercises.length > 0, `${entry.id} has no exercises`);
    for (const exercise of entry.exercises) {
      assert.ok(exercise.prompt.trim(), `${entry.id}/${exercise.id} has no prompt`);
      assert.ok(exercise.solution.trim(), `${entry.id}/${exercise.id} has no answer`);
    }
  }
});

test("lessons: the commands that can destroy a machine are flagged", () => {
  // Carried over from the Python suite, and it is the reason `danger` exists: `rm -r`
  // and `userdel -r` are both in the shipped library and both say what they cost.
  const flagged = repository()
    .list()
    .flatMap((entry) => entry.commands)
    .filter((command) => command.danger)
    .map((command) => command.command);

  assert.ok(flagged.some((command) => command.startsWith("rm ")), "a recursive delete is flagged");
  assert.ok(flagged.some((command) => command.includes("userdel")), "an account removal is flagged");
});

test("lessons: a prerequisite that is not a lesson is reported", () => {
  const problems = repository().validate();
  assert.deepEqual(problems, [], "the shipped prerequisites must all resolve");

  const broken = repository({
    "one.yaml": lesson({ id: "one", prerequisites: ["does-not-exist"] }),
  }).validate();
  assert.match(broken.join("\n"), /prerequisite "does-not-exist" is not a lesson/);
});

test("lessons: every scenario lesson link resolves", () => {
  // The other half of the link: a scenario names lessons, and this is the side that
  // says whether they exist. `find` is what the scenario validator asks.
  const lessons = repository();
  for (const entry of lessons.list()) {
    for (const prerequisite of entry.prerequisites) {
      assert.ok(lessons.find(prerequisite) !== null, `${entry.id} -> ${prerequisite}`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/*  Loading and lookup                                                        */
/* -------------------------------------------------------------------------- */

test("lessons: a bundle with no lessons is not an error", () => {
  // A deployment may legitimately ship none, and the Python treated a missing
  // directory as "none" rather than as a fault.
  const empty = repository({});
  assert.deepEqual(empty.list(), []);
  assert.deepEqual(empty.validate(), []);
  assert.deepEqual(empty.ids(), []);
  assert.equal(empty.find("anything"), null);
});

test("lessons: an unknown lesson explains itself", () => {
  assert.throws(
    () => repository().get("does-not-exist"),
    (error: unknown) => error instanceof LessonError && /unknown lesson/.test(error.message),
  );
});

test("lessons: a lesson written under the wrong file name is reported", () => {
  // The id and the file name must agree or `ontrak lesson show <id>` cannot find it.
  const problems = repository({ "mismatch.yaml": lesson({ id: "something-else" }) }).validate();
  assert.match(problems.join("\n"), /the two must match/);
});

test("lessons: the id must be a slug, even when the file name agrees with it", () => {
  const problems = repository({ "Unit_Lesson.yaml": lesson({ id: "Unit_Lesson" }) }).validate();
  assert.match(problems.join("\n"), /id must be lowercase and dash-separated/);
});

test("lessons: a read-through with no exercises is reported", () => {
  const problems = repository({
    "reading.yaml": lesson({
      id: "reading",
      exercises: [],
      steps: [{ title: "Read this", body: "There is nothing to do." }],
    }),
  }).validate();
  assert.match(problems.join("\n"), /no exercises/);
});

test("lessons: a lesson that teaches nothing is reported", () => {
  const problems = repository({
    "empty.yaml": lesson({ id: "empty", commands: [], steps: [] }),
  }).validate();
  assert.match(problems.join("\n"), /teaches nothing/);
});

test("lessons: a self-prerequisite is reported", () => {
  const problems = repository({ "loop.yaml": lesson({ id: "loop", prerequisites: ["loop"] }) }).validate();
  assert.match(problems.join("\n"), /lists itself/);
});

test("lessons: duplicate commands and duplicate exercise ids are reported", () => {
  const problems = repository({
    "dupes.yaml": lesson({
      id: "dupes",
      commands: [
        { command: "ls -l", what: "list in long form" },
        { command: "ls -l", what: "the same command again" },
      ],
      exercises: [
        { id: "one", prompt: "do it", solution: "ls -l" },
        { id: "one", prompt: "do it again", solution: "ls -l" },
      ],
    }),
  }).validate();
  const joined = problems.join("\n");
  assert.match(joined, /duplicate command entry "ls -l"/);
  assert.match(joined, /duplicate exercise id "one"/);
});

test("lessons: an exercise without an answer is reported, because the student marks it", () => {
  const problems = repository({
    "unanswered.yaml": lesson({
      id: "unanswered",
      exercises: [{ id: "one", prompt: "do it", solution: "" }],
    }),
  }).validate();
  assert.match(problems.join("\n"), /has no solution/);
});

/* -------------------------------------------------------------------------- */
/*  Refusals at load, and the record parser                                   */
/* -------------------------------------------------------------------------- */

test("lessons: a record that is not a mapping is refused with the file named", () => {
  const broken = { "broken.yaml": "not a mapping" } as unknown as LessonManifests;
  assert.throws(
    () => repository(broken).load(),
    (error: unknown) => error instanceof LessonError && /broken\.yaml: top level must be a mapping/.test(error.message),
  );
});

test("lessons: an unreadable number is refused by field rather than defaulted", () => {
  // The port's divergence from the Python, pinned: `difficulty: "three"` must not
  // become 1, because 1 is inside the range the validator checks.
  assert.throws(
    () => repository({ "bad.yaml": lesson({ id: "bad", difficulty: "three" }) }).load(),
    (error: unknown) => error instanceof LessonError && /difficulty must be a whole number/.test(error.message),
  );
});

test("lessons: two files claiming one id are refused rather than silently merged", () => {
  // Python's dict assignment kept whichever file was read last, which is data loss in a
  // layout whose ids live inside the files. `scenarios.ts` refuses the same thing.
  const manifests = {
    "first.yaml": lesson({ id: "same-id" }),
    "second.yaml": lesson({ id: "same-id" }),
  };
  assert.throws(() => repository(manifests).list(), /both claim the id "same-id"/);
});

test("lessons: the record parser names the file it could not read", () => {
  assert.throws(() => parseLessonRecord("{not json", "broken.json"), /broken\.json: invalid JSON/);
  assert.throws(() => parseLessonRecord("[]", "broken.json"), /broken\.json: top level must be a mapping/);

  // And the happy path is the same parser the bundle path uses.
  const parsed = parseLessonRecord(JSON.stringify(lesson()), "unit-lesson.json");
  assert.equal(parsed.id, "unit-lesson");
});

/* -------------------------------------------------------------------------- */
/*  What a caller reads back                                                  */
/* -------------------------------------------------------------------------- */

test("lessons: the shell block collects commands in the order a student meets them", () => {
  const entry = repository().get("linux-permissions");
  const block = lessonAllShell(entry);
  assert.match(block, /chmod/);

  const first = entry.commands[0];
  const second = entry.commands[1];
  assert.ok(first, "the lesson has a first command");
  assert.ok(second, "the lesson has a second command");
  assert.ok(
    block.indexOf(first.command) < block.indexOf(second.command),
    "the first command comes before the second",
  );
});

test("lessons: a scenario's lesson list drops a stale id instead of breaking the page", () => {
  const lessons = repository();
  const resolved = lessons.forScenario(["linux-permissions", "does-not-exist"]);
  assert.deepEqual(
    resolved.map((entry) => entry.id),
    ["linux-permissions"],
  );
});

test("lessons: the public view is what a student may see, and it carries no file name", () => {
  const view = lessonPublicView(repository().get("linux-permissions"));
  assert.equal(view.id, "linux-permissions");
  assert.equal("fileName" in view, false, "the file it lives in is not a student's business");
  assert.ok(Array.isArray(view.exercises) && (view.exercises as unknown[]).length > 0);
  assert.equal(Array.isArray(view.commands), true);
});

test("lessons: byPlatform groups the library the way the page lists it", () => {
  const grouped = repository().byPlatform();
  assert.ok(grouped.has("linux"));
  assert.ok(grouped.has("windows"));
  const total = [...grouped.values()].reduce((sum, bucket) => sum + bucket.length, 0);
  assert.equal(total, repository().list().length);
});

test("lessons: the repository is usable as the scenario validator's lesson view", () => {
  // A compile-time assertion rather than a runtime one: `scenarios.ts` takes a
  // `LessonFacts`, and this is what proves a scenario can ask whether its lessons
  // exist without an adapter between the two modules.
  const facts: LessonFacts = repository();
  assert.equal(facts.find("linux-permissions") === null, false);
  assert.equal(facts.find("nope") === null, true);
});
