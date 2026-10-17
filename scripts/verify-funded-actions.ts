/**
 * The funded-program server actions, run against a real PostgreSQL database.
 *
 * The rules in `src/lib/program-rules.ts` are unit-tested and pure, which proves what they
 * decide and not that anything asks them. The actions are where a rule becomes a refusal, and
 * this drives them exactly as a form does: real Prisma writes against a database seeded by
 * `prisma/seed.ts`, through the real session check and the real tenancy permissions.
 *
 * Only the request plumbing is replaced — `redirect`, `cookies`, `next/cache` and `server-only`
 * have no meaning outside a Next request — and it is replaced by patching CommonJS resolution,
 * which is what tsx loads this repo's `.ts` files through.
 *
 *   npm run verify:funded          # needs VERIFY_ACTIONS_DATABASE_URL
 *
 * Point it at a **throwaway** database that has migrations applied and the seed loaded:
 *
 *   createdb ontrak_actions_verify
 *   VERIFY_ACTIONS_DATABASE_URL=postgres://…/ontrak_actions_verify npx prisma migrate deploy
 *   VERIFY_ACTIONS_DATABASE_URL=postgres://…/ontrak_actions_verify npm run db:seed
 *
 * The script refuses to run against `DATABASE_URL`, because it writes: it creates a course, a
 * class and enrolments, and deletes them again before it exits. A database it has never seen is
 * the only kind it is safe to point at a seeded demo.
 */

import assert from "node:assert/strict";
import Module from "node:module";

import { SignJWT } from "jose";

/* -------------------------------------------------------------------------- */
/*  The request plumbing, before anything that needs it is imported           */
/* -------------------------------------------------------------------------- */

interface RedirectSignal extends Error {
  digest?: string;
}

const plumbing = {
  /** The session cookie the harness mints, standing in for the request's cookie jar. */
  cookie: null as { name: string; value: string } | null,
  /** Every `redirect` the actions threw, in order. */
  redirects: [] as string[],
};

const cookieStore = {
  get: (name: string) =>
    plumbing.cookie && name === plumbing.cookie.name
      ? { name, value: plumbing.cookie.value }
      : undefined,
  set() {},
  delete() {},
  getAll: () => [],
  has: () => false,
};

const redirect = (url: string): never => {
  const error: RedirectSignal = new Error(`NEXT_REDIRECT;${url}`);
  error.digest = `NEXT_REDIRECT;replace;${url};307;`;
  plumbing.redirects.push(url);
  throw error;
};

const STUBS: Record<string, unknown> = {
  // A build-time marker Next strips; importing it outside a bundle would fail.
  "server-only": {},
  "client-only": {},
  "next/headers": {
    cookies: async () => cookieStore,
    headers: async () => ({ get: () => null, has: () => false }),
    draftMode: async () => ({ isEnabled: false }),
  },
  "next/navigation": {
    redirect,
    permanentRedirect: redirect,
    notFound: () => {
      const error: RedirectSignal = new Error("NEXT_NOT_FOUND");
      error.digest = "NEXT_NOT_FOUND";
      throw error;
    },
  },
  "next/cache": { revalidatePath() {}, revalidateTag() {} },
};

/**
 * `Module._load` is CommonJS's own entry point and is not in the public typings, so it is
 * reached through a narrow structural type rather than widened to `any`.
 */
const load = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = load._load;
load._load = function patched(this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return originalLoad.call(this, request, parent, isMain);
};

/* -------------------------------------------------------------------------- */
/*  The checks                                                                */
/* -------------------------------------------------------------------------- */

const results: string[] = [];
let failures = 0;

/**
 * Assertions are synchronous on purpose: a `check` whose body awaits returns a promise nobody
 * awaits, and the check passes without ever running. Values that need a query are read before
 * the check, which also reads better as "this is what the database holds".
 */
function check(name: string, assertion: () => void): void {
  try {
    assertion();
    results.push(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`FAIL   ${name}: ${(error as Error).message}`);
  }
}

/** What the last action answered: the redirect it threw, decoded. */
function answered(): { error: string | null; flash: string | null } {
  const url = plumbing.redirects[plumbing.redirects.length - 1];
  if (!url) throw new Error("the action returned without redirecting");
  const params = new URL(url, "http://localhost").searchParams;
  return { error: params.get("error"), flash: params.get("flash") };
}

const reset = (): void => {
  plumbing.redirects.length = 0;
};

/** Form fields, as the page's form would post them. */
const form = (fields: Record<string, string | number>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, String(value));
  return data;
};

async function main(): Promise<void> {
  const url = process.env.VERIFY_ACTIONS_DATABASE_URL;
  if (!url) {
    throw new Error(
      "Set VERIFY_ACTIONS_DATABASE_URL to a throwaway database with migrations applied and the seed loaded (see the header of this file).",
    );
  }
  if (url === process.env.DATABASE_URL) {
    throw new Error("VERIFY_ACTIONS_DATABASE_URL is the app's own DATABASE_URL; this script writes, so point it somewhere expendable.");
  }
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "verify-funded-actions-secret";

  const { prisma } = await import("../src/lib/db");
  const { employerSlotUsage } = await import("../src/lib/program-rules");
  const { reportCsv, reportRows, reportSummary } = await import("../src/lib/program-report");
  const actions = await import("../src/app/actions/tenants");

  /**
   * Call an action the way Next does. A refusal is a thrown redirect rather than a return value,
   * so the throw is swallowed here and read back through `answered()`.
   */
  const act = new Proxy(actions, {
    get: (target, key: string) =>
      async (...args: unknown[]) => {
        try {
          return await (target as unknown as Record<string, (...a: unknown[]) => Promise<void>>)[key](...args);
        } catch (error) {
          if (String((error as RedirectSignal)?.digest ?? "").startsWith("NEXT_REDIRECT")) return undefined;
          throw error;
        }
      },
  }) as unknown as Record<
    "createCourse" | "addCourseModule" | "setListingState" | "enrollLearner" | "recordAttendance" | "setAssessment" | "setEnrollmentStatus",
    (formData: FormData) => Promise<void>
  >;

  const tenant = await prisma.organization.findUnique({ where: { slug: "mass-workforce-development" } });
  const program = tenant ? await prisma.program.findFirst({ where: { organizationId: tenant.id } }) : null;
  if (!tenant || !program) {
    throw new Error("No seeded FAST AI tenancy: run `npm run db:seed` against VERIFY_ACTIONS_DATABASE_URL first.");
  }
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@ontrak.local" } });
  assert.ok(admin.platformAdmin, "the harness signs in as the platform operator");

  plumbing.cookie = {
    name: "ontrak_training_session",
    value: await new SignJWT({ email: admin.email, role: admin.role, name: admin.name })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(admin.id)
      .setIssuedAt()
      .setExpirationTime("604800s")
      .sign(new TextEncoder().encode(process.env.AUTH_SECRET)),
  };

  const loadTenant = () =>
    prisma.organization.findUniqueOrThrow({
      where: { id: tenant.id },
      include: {
        classes: {
          include: {
            course: { select: { title: true } },
            program: { select: { name: true, funder: true } },
            sponsor: { select: { name: true } },
            enrollments: {
              include: {
                user: { select: { name: true, email: true } },
                attendances: { select: { status: true } },
              },
            },
          },
        },
      },
    });

  /** The report's rows, reduced to the facts the per-employer cap turns on. */
  const slotRows = (organization: Awaited<ReturnType<typeof loadTenant>>) =>
    organization.classes
      .filter((entry) => entry.programId === program.id)
      .flatMap((entry) =>
        entry.enrollments.map((enrollment) => ({
          employerId: entry.sponsorOrganizationId,
          employerName: entry.sponsor?.name ?? null,
          enrolledOn: enrollment.enrolledAt,
          status: enrollment.status,
          present: enrollment.attendances.filter((sitting) => sitting.status === "PRESENT").length,
          pricePerSlotCents: entry.pricePerSlotCents,
          funded: enrollment.funded,
        })),
      );

  const cleanTitle = "AI for Care Handoffs (verify)";
  const klass = await prisma.cohort.findFirstOrThrow({
    where: { organizationId: tenant.id, joinCode: "FASTCS" },
    include: { course: true },
  });
  const emails = ["funded.verify@ontrak.local", "unfunded.verify@ontrak.local"];

  /* Start from nothing: a previous run's rows would make the figures this checks wrong. */
  await prisma.course.deleteMany({ where: { organizationId: tenant.id, title: { startsWith: cleanTitle } } });
  await prisma.cohort.deleteMany({ where: { organizationId: tenant.id, joinCode: "FASTDT" } });
  await prisma.enrollment.deleteMany({ where: { user: { email: { in: emails } } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });

  /**
   * A course number nothing else in the program holds. The funder refuses a submission that
   * reuses one (§3.3, and `courseSubmissionProblems` enforces it), so a fixed number would make
   * this script fail on the second run against a database that still holds the first one's rows.
   */
  const taken = (
    await prisma.course.findMany({
      where: { organizationId: tenant.id, programId: program.id, courseNumber: { not: null } },
      select: { courseNumber: true },
    })
  ).map((entry) => entry.courseNumber);
  const freeNumber = Array.from({ length: 20 }, (_, index) => index + 1).find((number) => !taken.includes(number));
  if (!freeNumber) throw new Error("Every course number 1–20 is taken in this program; reseed the throwaway database.");

  const beforeLoad = await loadTenant();
  const before = reportSummary(reportRows({ organization: beforeLoad, classes: beforeLoad.classes }));

  const courseFields = (title: string, summary: string, extra: Record<string, string | number> = {}) => ({
    organizationId: tenant.id,
    programId: program.id,
    title,
    summary,
    topicAreas: "Generative AI\nAI productivity applications",
    courseNumber: freeNumber,
    maxSlotsPerOffering: 10,
    aiTools: "Microsoft 365 Copilot",
    targetOccupations: "Front-line staff",
    targetIndustries: "Home and community care",
    workplaceTasks: "Drafting a reply to a family member",
    languages: "",
    credentials: extra.credentials ?? "",
    instructionalHours: 6,
    pricePerSlot: 1800,
    audience: "Front-line staff",
    prerequisites: "None",
    ...extra,
  });

  /* ---------------------------------------------------------- createCourse */

  reset();
  await act.createCourse(
    form(courseFields("Getting Started with AI", "Setting up your laptop before the first session")),
  );
  check("createCourse refuses content the funder does not fund", () => {
    assert.match(answered().error ?? "", /device setup/);
    assert.match(answered().error ?? "", /WTFP/);
  });
  const refused = await prisma.course.findFirst({ where: { organizationId: tenant.id, title: "Getting Started with AI" } });
  check("the refused course was not written", () => assert.equal(refused, null));

  reset();
  await act.createCourse(
    form(courseFields(`${cleanTitle} (certificate)`, "Applying AI to a handoff note", { credentials: "Certificate of Completion" })),
  );
  check("createCourse refuses a certificate the provider issues itself", () =>
    assert.match(answered().error ?? "", /industry-recognized credential/),
  );

  reset();
  await act.createCourse(form(courseFields(cleanTitle, "Six instructor-led hours on summarising a client's history")));
  check("createCourse accepts a course that meets the answers", () =>
    assert.match(answered().flash ?? "", /added to the catalogue/),
  );

  const course = await prisma.course.findFirstOrThrow({ where: { organizationId: tenant.id, title: cleanTitle } });
  check("a new course is a draft, not a directory listing", () => assert.equal(course.directoryApprovedAt, null));

  /* ------------------------------------------------------ addCourseModule */

  reset();
  await act.addCourseModule(
    form({ courseId: course.id, title: "Setting up your account", hours: 1, objectives: "Create an account in the assistant" }),
  );
  check("addCourseModule refuses a module that teaches account access", () =>
    assert.match(answered().error ?? "", /account access/),
  );
  const modulesAfterRefusal = await prisma.courseModule.count({ where: { courseId: course.id } });
  check("no module was written for the refused one", () => assert.equal(modulesAfterRefusal, 0));

  /* ------------------------------------------------------- setListingState */

  reset();
  await act.setListingState(form({ courseId: course.id, state: "published" }));
  check("publishing is refused while the modules do not account for the hours", () =>
    assert.match(answered().error ?? "", /breaks them into no modules/),
  );

  for (const [title, hours] of [
    ["Where AI already sits in the handoff", 3],
    ["Prompting for a real handoff, and checking it", 3],
  ] as const) {
    reset();
    await act.addCourseModule(
      form({
        courseId: course.id,
        title,
        hours,
        objectives: "Apply the technique to a task from your own workload",
        activity: "Guided practice",
        outcome: "A checked draft",
      }),
    );
    check(`addCourseModule accepts “${title}”`, () => assert.match(answered().flash ?? "", /Module/));
  }

  reset();
  await act.setListingState(form({ courseId: course.id, state: "published" }));
  check("a course whose hours add up is listed", () =>
    assert.match(answered().flash ?? "", /listed in the funder's directory/),
  );
  const listed = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
  check("the listing carries an approval date", () => assert.ok(listed.directoryApprovedAt instanceof Date));

  /* --------------------------------------------------------- enrollLearner */

  for (const [email, name, funded] of [
    ["funded.verify@ontrak.local", "Funded Verify", "true"],
    ["unfunded.verify@ontrak.local", "Unfunded Verify", "false"],
  ] as const) {
    reset();
    await act.enrollLearner(form({ cohortId: klass.id, email, name, funded }));
    check(`enrolling ${name} succeeds`, () => assert.match(answered().flash ?? "", /is enrolled in/));
  }

  const fundedEnrollment = await prisma.enrollment.findFirstOrThrow({
    where: { cohortId: klass.id, user: { email: "funded.verify@ontrak.local" } },
  });
  const unfundedEnrollment = await prisma.enrollment.findFirstOrThrow({
    where: { cohortId: klass.id, user: { email: "unfunded.verify@ontrak.local" } },
  });
  check("the funding flag was stored as posted", () => {
    assert.equal(fundedEnrollment.funded, true);
    assert.equal(unfundedEnrollment.funded, false);
  });

  /* --------------------------- setAssessment and setEnrollmentStatus */

  reset();
  await act.setEnrollmentStatus(form({ enrollmentId: fundedEnrollment.id, status: "COMPLETED" }));
  check("a funded completion with no hours is refused", () => {
    assert.match(answered().error ?? "", /runs 8 instructional hours/);
    assert.match(answered().error ?? "", /make-up/);
  });

  reset();
  await act.setAssessment(form({ enrollmentId: fundedEnrollment.id, done: "record" }));
  check("the assessment is recorded", () => assert.match(answered().flash ?? "", /Assessment recorded/));

  reset();
  await act.setEnrollmentStatus(form({ enrollmentId: fundedEnrollment.id, status: "COMPLETED" }));
  check("an assessment without the hours is still not a completion", () =>
    assert.match(answered().error ?? "", /attended 0/),
  );

  const stillOpen = await prisma.enrollment.findUniqueOrThrow({ where: { id: fundedEnrollment.id } });
  check("the refused completion was not written", () => {
    assert.equal(stillOpen.status, "ENROLLED", "no attendance, no completion");
    assert.equal(stillOpen.completedAt, null);
    assert.ok(stillOpen.assessmentRecordedAt instanceof Date, "the assessment stayed recorded");
  });

  reset();
  await act.recordAttendance(
    form({ enrollmentId: fundedEnrollment.id, sessionDate: "2027-04-06", hours: 2, status: "PRESENT" }),
  );
  check("attendance is recorded", () => assert.match(answered().flash ?? "", /Attendance recorded/));

  reset();
  await act.setEnrollmentStatus(form({ enrollmentId: fundedEnrollment.id, status: "COMPLETED" }));
  check("two of eight hours is still refused", () => assert.match(answered().error ?? "", /attended 2/));

  reset();
  await act.recordAttendance(
    form({ enrollmentId: fundedEnrollment.id, sessionDate: "2027-04-13", hours: 6, status: "PRESENT" }),
  );
  check("the make-up hours are recorded", () => assert.match(answered().flash ?? "", /Attendance recorded/));

  reset();
  await act.setEnrollmentStatus(form({ enrollmentId: fundedEnrollment.id, status: "COMPLETED" }));
  check("a funded completion with all eight hours is recorded", () =>
    assert.match(answered().flash ?? "", /Completion recorded/),
  );

  const completed = await prisma.enrollment.findUniqueOrThrow({ where: { id: fundedEnrollment.id } });
  check("the completion carries its date", () => {
    assert.equal(completed.status, "COMPLETED");
    assert.ok(completed.completedAt instanceof Date);
  });

  /* The same trainee, the same course, a second class: one slot may be reimbursed once. */
  const secondClass = await prisma.cohort.create({
    data: {
      name: "AI-Assisted Customer Support (verify duplicate)",
      joinCode: "FASTDT",
      instructorId: completed.userId,
      organizationId: tenant.id,
      programId: program.id,
      courseId: klass.courseId,
      sponsorOrganizationId: klass.sponsorOrganizationId,
      startsOn: klass.startsOn,
      endsOn: klass.endsOn,
      instructionalHours: klass.instructionalHours,
      seats: 4,
      pricePerSlotCents: klass.pricePerSlotCents,
      deliveryMode: "instructor-led",
    },
  });
  const duplicate = await prisma.enrollment.create({
    data: {
      cohortId: secondClass.id,
      userId: completed.userId,
      organizationId: tenant.id,
      sponsorOrganizationId: klass.sponsorOrganizationId,
      funded: true,
      // Every hour of the course attended, so the only thing left to refuse is the duplicate slot.
      hoursAttended: klass.course?.instructionalHours ?? klass.instructionalHours ?? 0,
      status: "ATTENDED",
    },
  });
  // The assessment first, so the refusal that comes back is about the duplicate slot rather than
  // about an assessment nobody has recorded yet.
  reset();
  await act.setAssessment(form({ enrollmentId: duplicate.id, done: "record" }));
  reset();
  await act.setEnrollmentStatus(form({ enrollmentId: duplicate.id, status: "COMPLETED" }));
  check("a slot may be reimbursed only once per trainee per course", () =>
    assert.match(answered().error ?? "", /only once per trainee per course/),
  );

  reset();
  await act.setEnrollmentStatus(form({ enrollmentId: unfundedEnrollment.id, status: "COMPLETED" }));
  check("an unfunded participant may be marked complete without the funder's hours", () =>
    assert.match(answered().flash ?? "", /Completion recorded/),
  );

  /* --------------------------------------- what the unfunded seat is worth */

  const loaded = await loadTenant();
  const rows = reportRows({ organization: loaded, classes: loaded.classes });
  const summary = reportSummary(rows);
  // Measured against the database as it was found, so the script is honest on a demo database
  // somebody has already been using: what it asserts is what *this run* added, not a total that
  // only holds on a fresh seed.
  check("the report counts only funded completions", () => {
    assert.equal(summary.completed - before.completed, 1, "the funded completion this run recorded");
    assert.equal(
      summary.reimbursableCents - before.reimbursableCents,
      klass.pricePerSlotCents ?? 0,
      "one slot at the class's own price, for the funded completion",
    );
  });

  const [usage] = employerSlotUsage(slotRows(loaded), program.employerSlotCap ?? null);
  const [was] = employerSlotUsage(slotRows(beforeLoad), program.employerSlotCap ?? null);
  check("the unfunded completion spends no employer slot", () => {
    assert.equal(usage.slotsUsed - (was?.slotsUsed ?? 0), 1, "one funded completion, and not the unfunded one");
    assert.equal(usage.reimbursableCompletions - (was?.reimbursableCompletions ?? 0), 1);
    assert.equal(usage.completions - (was?.completions ?? 0), 1, "two completions happened; one is CommCorp's");
  });

  check("the file marks the unfunded participant as not a FAST AI trainee", () => {
    const csv = reportCsv(rows);
    assert.match(csv, /unfunded\.verify@ontrak\.local,no,/);
    assert.match(csv, /funded\.verify@ontrak\.local,yes,/);
  });

  /* ------------------------------------------------------------- clean up */

  await prisma.course.deleteMany({ where: { organizationId: tenant.id, title: { startsWith: cleanTitle } } });
  await prisma.cohort.deleteMany({ where: { organizationId: tenant.id, joinCode: "FASTDT" } });
  await prisma.enrollment.deleteMany({ where: { user: { email: { in: emails } } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  const leftovers = await prisma.course.count({ where: { organizationId: tenant.id, title: { startsWith: cleanTitle } } });
  check("the run left nothing behind", () => assert.equal(leftovers, 0));

  await prisma.$disconnect();

  console.log(results.join("\n"));
  console.log(`\n${results.length - failures}/${results.length} checks passed against ${new URL(url).pathname.slice(1)}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  // Whatever ran before the failure is still worth seeing: a check that failed and a check that
  // never got the chance are different diagnoses.
  if (results.length > 0) console.log(results.join("\n"));
  console.error(`verify-funded-actions: ${(error as Error).message}`);
  process.exitCode = 1;
});
