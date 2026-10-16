/**
 * The AI classroom: the host a deployment serves, the address a class carries, and the
 * specification AthenIQ's classroom host generates from.
 *
 * These are the rules a funded class depends on and nobody can see from a page. A classroom
 * that was never generated is a class with a door that leads nowhere; an address that was
 * refused is a link to nowhere *or* to somebody else's page; and a specification generated
 * from the wrong columns is a lesson that teaches what the course does not assess. Each is
 * cheap to get wrong and expensive to notice, so each is pinned here.
 *
 * The document's shape is pinned as *field names* rather than as a whole object, because the
 * shape is AthenIQ's: `courses/<slug>/openmaic/classrooms.json` in that repository, read by
 * its `scripts/check-classrooms.py` and turned into a lesson by OpenMAIC. A field renamed here
 * without being renamed there is a spec that generates nothing, so the names are asserted
 * explicitly and `chapter`/`linked_units` are asserted *absent* — they point into an Open edX
 * package, and OnTrak's courses are not one.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/classroom.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLASSROOM_ACTIVITY_TYPES,
  CLASSROOM_ENABLED_ENV,
  CLASSROOM_HOME_PATH,
  CLASSROOM_SPEC_GATEWAY,
  CLASSROOM_SPEC_PROVIDER,
  CLASSROOM_SPEC_VERSION,
  CLASSROOM_URL_ENV,
  classroomConfigFromEnv,
  classroomDoor,
  classroomDoorFromEnv,
  classroomHomeUrl,
  classroomLink,
  classroomLinkRefusal,
  classroomProblems,
  classroomSpec,
  classroomSpecFilename,
  classroomSpecJson,
  courseCodeFor,
  courseKeyFor,
  courseRun,
  effectiveClassroom,
  slug,
} from "../src/lib/classroom-rules";
import { integrationStatuses } from "../src/lib/integration-status";

const HOST = "https://classroom.innotel.us";
const on = { ONTRAK_CLASSROOM_ENABLED: "1", ONTRAK_CLASSROOM_URL: HOST };

/** The course every spec test is generated from — a FAST AI course, as OnTrak stores it. */
const COURSE = {
  title: "Applied AI for the Frontline Role",
  summary: "Six hours of hands-on practice with generative AI on tasks a frontline worker already does.",
  audience: "Frontline staff and team leads in service delivery roles",
  prerequisites: "None. No technical background assumed.",
  instructionalHours: 6,
  deliveryMode: "instructor-led",
};

const MODULES = [
  {
    position: 1,
    title: "Where AI already sits in your work",
    hours: 1.5,
    objectives: "Name three tasks in your own week that are text-in, text-out\nDistinguish what a model does from what it knows",
    activity: "List three tasks from your own week and mark which one AI may help with",
    outcome: "A three-item list with one justified choice",
  },
  {
    position: 2,
    title: "Prompts for your own desk",
    hours: 2,
    objectives: "- Write a prompt for a task from your workload\n- Check the answer before it goes out",
    // No activity and no assessment authored: the spec must show the gap rather than
    // invent a scene nobody wrote.
    activity: null,
    outcome: null,
  },
];

function specInput(overrides: Partial<Parameters<typeof classroomSpec>[0]> = {}) {
  return {
    organizationSlug: "mass-workforce-development",
    providerName: "Massachusetts Workforce Development",
    sponsorName: "Charles River Home Care",
    startsOn: "2027-03-01",
    course: COURSE,
    modules: MODULES,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  The host                                                                   */
/* -------------------------------------------------------------------------- */

test("classroom: off unless an operator turns it on and says where it is", () => {
  const off = classroomConfigFromEnv({});
  assert.equal(off.enabled, false);
  assert.equal(off.url, null);
  assert.equal(classroomHomeUrl(off), null, "an unconfigured deployment offers nothing");
  assert.deepEqual(classroomDoorFromEnv({}), { kind: "off" });

  // Knowing where a classroom host would be is not asking for one: enabling is a decision.
  const addressOnly = classroomConfigFromEnv({ ONTRAK_CLASSROOM_URL: HOST });
  assert.equal(addressOnly.enabled, false);
  assert.equal(addressOnly.url, null);
});

test("classroom: enabled is the switch, and every truthy spelling counts", () => {
  for (const value of ["1", "true", "yes", "on", "ON"]) {
    assert.equal(classroomConfigFromEnv({ ...on, ONTRAK_CLASSROOM_ENABLED: value }).enabled, true, value);
  }
  for (const value of ["0", "false", "no", "off", ""]) {
    assert.equal(classroomConfigFromEnv({ ONTRAK_CLASSROOM_ENABLED: value }).enabled, false, value);
  }
});

test("classroom: the base address is reduced to its origin, quotes and all", () => {
  // A trailing slash or a path would double a segment once the host's own path is added,
  // and `.env`'s three readers disagree about quotes — the same convention as the lab's.
  const quoted = classroomConfigFromEnv({
    ONTRAK_CLASSROOM_ENABLED: "yes",
    ONTRAK_CLASSROOM_URL: `"${HOST}/library/"`,
  });
  assert.equal(quoted.url, HOST);
  assert.equal(classroomHomeUrl(quoted), `${HOST}${CLASSROOM_HOME_PATH}`);
});

test("classroom: an address that was refused keeps its reason instead of a link", () => {
  const noAddress = classroomDoor(classroomConfigFromEnv({ ONTRAK_CLASSROOM_ENABLED: "1" }), {
    ONTRAK_CLASSROOM_ENABLED: "1",
  });
  assert.equal(noAddress.kind, "misconfigured");
  assert.ok(noAddress.kind === "misconfigured" && noAddress.issues[0]!.includes(CLASSROOM_URL_ENV));

  const relative = { ONTRAK_CLASSROOM_ENABLED: "1", ONTRAK_CLASSROOM_URL: "classroom.innotel.us" };
  const refused = classroomDoor(classroomConfigFromEnv(relative), relative);
  assert.equal(refused.kind, "misconfigured");
  assert.ok(refused.kind === "misconfigured" && refused.issues[0]!.includes("not an absolute URL"));

  const wrongScheme = { ONTRAK_CLASSROOM_ENABLED: "1", ONTRAK_CLASSROOM_URL: "ftp://classroom.test" };
  const scheme = classroomDoor(classroomConfigFromEnv(wrongScheme), wrongScheme);
  assert.equal(scheme.kind, "misconfigured");
  assert.ok(scheme.kind === "misconfigured" && scheme.issues[0]!.includes("not an http(s) URL"));

  // And the door the other three states make: the host's own home.
  assert.deepEqual(classroomDoor(classroomConfigFromEnv(on), on), {
    kind: "external",
    url: `${HOST}${CLASSROOM_HOME_PATH}`,
  });
});

test("classroom: the switch and the address are the only two variables read", () => {
  assert.equal(CLASSROOM_ENABLED_ENV, "ONTRAK_CLASSROOM_ENABLED");
  assert.equal(CLASSROOM_URL_ENV, "ONTRAK_CLASSROOM_URL");
});

/* -------------------------------------------------------------------------- */
/*  A stored address                                                           */
/* -------------------------------------------------------------------------- */

test("classroom: a stored address is validated before it can be rendered", () => {
  const lesson = `${HOST}/lesson/fastap-mod01-where-ai-already-sits-you?from=ontrak#scene-2`;
  assert.equal(classroomLink(lesson), lesson);
  assert.equal(classroomLink(`  ${HOST}/library/  `), `${HOST}/library/`);

  // The refusal that matters most: `javascript:` in an `href` runs script as the reader.
  assert.equal(classroomLink("javascript:alert(document.cookie)"), null);
  assert.equal(classroomLink("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(classroomLink("ftp://classroom.test/lesson"), null);
  // Credentials in a field every member of the class can read are not a secret.
  assert.equal(classroomLink("https://teacher:hunter2@classroom.test/lesson"), null);
  // A bare host or a path is not an address.
  assert.equal(classroomLink("classroom.test/lesson"), null);
  assert.equal(classroomLink("/lesson/1"), null);
  assert.equal(classroomLink(""), null);
  assert.equal(classroomLink(null), null);
  assert.equal(classroomLink(undefined), null);
});

test("classroom: a refusal says what to change", () => {
  assert.match(classroomLinkRefusal("javascript:alert(1)"), /javascript address/);
  assert.match(classroomLinkRefusal("https://a:b@classroom.test/x"), /username and password/);
  assert.match(classroomLinkRefusal("classroom.test/x"), /absolute http\(s\) address/);
  assert.match(classroomLinkRefusal("   "), /cannot be empty/);
});

/* -------------------------------------------------------------------------- */
/*  Which classroom a class is offered                                         */
/* -------------------------------------------------------------------------- */

test("classroom: a class's own classroom wins, and its course's is the fallback", () => {
  const course = { classroomUrl: `${HOST}/lesson/course` };
  const klass = { classroomUrl: `${HOST}/lesson/this-sitting` };

  assert.deepEqual(effectiveClassroom(course, klass), {
    url: `${HOST}/lesson/this-sitting`,
    source: "class",
    refused: [],
  });
  assert.deepEqual(effectiveClassroom(course, { classroomUrl: null }), {
    url: `${HOST}/lesson/course`,
    source: "course",
    refused: [],
  });
  assert.deepEqual(effectiveClassroom(course, null), {
    url: `${HOST}/lesson/course`,
    source: "course",
    refused: [],
  });
  assert.deepEqual(effectiveClassroom({ classroomUrl: null }, null), {
    url: null,
    source: null,
    refused: [],
  });
});

test("classroom: a mistyped override is reported and the course's classroom still opens", () => {
  // The failure this prevents is a whole class with no way in because one field was mistyped.
  const effective = effectiveClassroom(
    { classroomUrl: `${HOST}/lesson/course` },
    { classroomUrl: "javascript:alert(1)" },
  );
  assert.equal(effective.url, `${HOST}/lesson/course`);
  assert.equal(effective.source, "course");
  assert.equal(effective.refused.length, 1);
  assert.match(effective.refused[0]!, /class's classroom address was refused/);

  // With nothing behind it, the course's own refusal is reported too.
  const both = effectiveClassroom({ classroomUrl: "not a url" }, { classroomUrl: "not a url" });
  assert.equal(both.url, null);
  assert.equal(both.source, null);
  assert.equal(both.refused.length, 2);
});

test("classroom: what is missing is named, in the order the page prints it", () => {
  const subject = {
    course: { title: COURSE.title, classroomUrl: null, moduleCount: MODULES.length },
    cohort: { name: "FAST AI — Spring cohort 1", classroomUrl: null },
  };

  // A deployment with no host, a class with no classroom: two problems, both actionable.
  const off = classroomProblems(subject, classroomConfigFromEnv({}));
  assert.equal(off.length, 2);
  assert.match(off[0]!.message, new RegExp(CLASSROOM_ENABLED_ENV));
  // Without a host there is nothing to attach to, and the sentence says that rather than
  // telling a provider to paste an address into a deployment that has nowhere to put it.
  assert.match(off[1]!.message, /has no AI classroom attached, and there is nowhere to host one/);

  // With a host, the only thing left is to generate one.
  const ready = classroomProblems(subject, classroomConfigFromEnv(on));
  assert.equal(ready.length, 1);
  assert.match(ready[0]!.message, /Build one from the generated spec/);

  // An attached classroom closes the last one — and a course with no modules cannot be
  // generated from at all, which is a fact about the course rather than about the classroom.
  const attached = classroomProblems(
    {
      course: { title: COURSE.title, classroomUrl: `${HOST}/lesson/x`, moduleCount: 2 },
      cohort: { name: "FAST AI — Spring cohort 1", classroomUrl: null },
    },
    classroomConfigFromEnv(on),
  );
  assert.deepEqual(attached, []);

  const unauthored = classroomProblems(
    { course: { title: COURSE.title, classroomUrl: `${HOST}/lesson/x`, moduleCount: 0 } },
    classroomConfigFromEnv(on),
  );
  assert.equal(unauthored.length, 1);
  assert.match(unauthored[0]!.message, /has no modules yet/);
});

/* -------------------------------------------------------------------------- */
/*  The course key                                                             */
/* -------------------------------------------------------------------------- */

/** AthenIQ's own rule for a course key: `course-v1:<org>+<course>+<run>`. */
const COURSE_KEY = /^course-v1:[^+\s]+\+[^+\s]+\+[^+\s]+$/;

test("spec: the course key is the shape AthenIQ imports a course under", () => {
  const key = courseKeyFor({
    organizationSlug: "mass-workforce-development",
    courseTitle: COURSE.title,
    startsOn: "2027-03-01",
  });
  assert.match(key, COURSE_KEY);
  assert.equal(key, "course-v1:MassWorkforceDevelopment+AAFR+2027_T1");

  // A provider with its own code keeps it.
  assert.equal(
    courseKeyFor({
      organizationSlug: "mass-workforce-development",
      courseTitle: COURSE.title,
      startsOn: "2027-03-01",
      courseCode: "FAST101",
    }),
    "course-v1:MassWorkforceDevelopment+FAST101+2027_T1",
  );
  // A second sitting is a second run, which is what makes the two classrooms distinguishable.
  assert.equal(
    courseKeyFor({
      organizationSlug: "mass-workforce-development",
      courseTitle: COURSE.title,
      startsOn: "2028-06-15",
    }).split("+")[2],
    "2028_T2",
  );
});

test("spec: the run is the quarter the training starts, and a bad date says so", () => {
  assert.equal(courseRun("2027-01-01"), "2027_T1");
  assert.equal(courseRun("2027-03-31"), "2027_T1");
  assert.equal(courseRun("2027-04-01"), "2027_T2");
  assert.equal(courseRun("2027-09-30"), "2027_T3");
  assert.equal(courseRun("2027-10-01"), "2027_T4");
  assert.equal(courseRun(new Date("2028-12-31T00:00:00.000Z")), "2028_T4");
  assert.equal(courseRun("not a date"), "unscheduled");
});

test("spec: a course code is the provider's, or the title's initials", () => {
  assert.equal(courseCodeFor(COURSE.title), "AAFR", "the, for and of are not initials worth keeping");
  assert.equal(courseCodeFor("Prompts for your own desk"), "PYOD");
  assert.equal(courseCodeFor(COURSE.title, "FAST101"), "FAST101");
  assert.equal(courseCodeFor(COURSE.title, "  fast 101  "), "fast101");
  assert.equal(courseCodeFor("!!!"), "COURSE", "a title with no words still gets a code");
});

/* -------------------------------------------------------------------------- */
/*  The specification                                                          */
/* -------------------------------------------------------------------------- */

test("spec: the document is AthenIQ's, field for field", () => {
  const spec = classroomSpec(specInput());

  assert.equal(spec.version, CLASSROOM_SPEC_VERSION);
  assert.equal(spec.provider, CLASSROOM_SPEC_PROVIDER);
  assert.equal(spec.gateway, CLASSROOM_SPEC_GATEWAY, "the platform routes every call through OmniRoute");
  assert.equal(spec.locale, "en");
  assert.match(spec.source_course, COURSE_KEY);

  // The four default agent roles its README tells a provider to submit alongside the prompt.
  assert.deepEqual(Object.keys(spec.defaults).sort(), [
    "assessment",
    "classmates",
    "interaction",
    "teacher_persona",
  ]);
  assert.match(spec.defaults.teacher_persona, /Massachusetts Workforce Development/);
  assert.ok(
    spec.defaults.classmates.some((mate) => mate.includes("Charles River Home Care")),
    "a sponsored class's classmates include the employer who pays for the seats",
  );

  // One classroom per module, and the OLX pointers are deliberately not guessed at.
  assert.equal(spec.classrooms.length, MODULES.length);
  for (const entry of spec.classrooms) {
    assert.deepEqual(Object.keys(entry).sort(), ["activities", "id", "objectives", "prompt", "title"]);
    assert.match(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${entry.id} is not a slug`);
    assert.ok(entry.title.length > 0);
    assert.ok(entry.prompt.length > 0);
    assert.ok(entry.objectives.length > 0);
    assert.ok(entry.activities.length > 0);
    for (const activity of entry.activities) {
      assert.ok(
        (CLASSROOM_ACTIVITY_TYPES as readonly string[]).includes(activity.type),
        `${activity.type} is not an activity kind this estate uses`,
      );
    }
    assert.equal("chapter" in entry, false, "chapter is an OLX pointer, and there is no package");
    assert.equal("linked_units" in entry, false, "linked_units point into an OLX package");
  }

  const ids = spec.classrooms.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique within the document");
});

test("spec: the objectives and the assessment come from the course, not from here", () => {
  const spec = classroomSpec(specInput());
  const first = spec.classrooms[0]!;

  assert.deepEqual(first.objectives, [
    "Name three tasks in your own week that are text-in, text-out",
    "Distinguish what a model does from what it knows",
  ], "one objective per line, in the order the course states them");
  assert.match(first.prompt, /Name three tasks in your own week/);
  assert.match(first.prompt, /AI may help with/, "the learner's own activity is in the prompt");
  assert.match(first.prompt, /justified choice/, "and so is how the module is assessed");

  // The second module authored neither an activity nor an outcome: slides only, so the gap is
  // visible instead of covered by a plausible-looking scene nobody wrote.
  const second = spec.classrooms[1]!;
  assert.deepEqual(
    second.activities.map((activity) => activity.type),
    ["slides"],
  );
  assert.deepEqual(second.objectives, [
    "Write a prompt for a task from your workload",
    "Check the answer before it goes out",
  ], "a bulleted objective line is still an objective");
  assert.equal(/undefined|null/.test(JSON.stringify(spec)), false, "no field may carry a hole");
});

test("spec: the file a provider downloads parses, and is named after its course", () => {
  const json = classroomSpecJson(specInput());
  assert.equal(json.endsWith("\n"), true, "a file ends in a newline");
  const parsed = JSON.parse(json) as { classrooms: unknown[] };
  assert.equal(parsed.classrooms.length, MODULES.length);
  assert.equal(classroomSpecFilename(COURSE.title), "applied-ai-for-the-frontline-role-classrooms.json");
  assert.equal(classroomSpecFilename("!!!"), "course-classrooms.json");
  assert.equal(slug("Applied AI for the Frontline Role"), "applied-ai-for-the-frontline-role");
});

test("spec: an unauthored course generates a document that says it is empty", () => {
  // A spec with no classrooms is worse than no spec: AthenIQ's linter refuses it and a reader
  // would not notice, so this pins the fact that it *is* empty rather than pretending.
  const spec = classroomSpec(specInput({ modules: [], sponsorName: null }));
  assert.deepEqual(spec.classrooms, []);
  assert.equal(spec.defaults.classmates.length, 2, "an unsponsored class has the two learner roles");
});

/* -------------------------------------------------------------------------- */
/*  The console                                                               */
/* -------------------------------------------------------------------------- */

test("console: the classroom is a fourth integration, and it reads like the other three", () => {
  const off = integrationStatuses({}).find((entry) => entry.id === "classroom")!;
  assert.equal(off.state, "off");
  assert.deepEqual(off.details, []);
  assert.deepEqual(off.issues, []);

  const ready = integrationStatuses(on).find((entry) => entry.id === "classroom")!;
  assert.equal(ready.state, "ready");
  assert.deepEqual(ready.issues, []);
  assert.equal(ready.details.find((detail) => detail.key === "host")?.value, HOST);
  assert.equal(
    ready.details.find((detail) => detail.key === "home")?.value,
    `${HOST}${CLASSROOM_HOME_PATH}`,
  );

  const refused = integrationStatuses({
    ONTRAK_CLASSROOM_ENABLED: "1",
    ONTRAK_CLASSROOM_URL: "nope",
  }).find((entry) => entry.id === "classroom")!;
  assert.equal(refused.state, "incomplete");
  assert.deepEqual(refused.details, []);
  assert.ok(refused.issues.length > 0);
});
