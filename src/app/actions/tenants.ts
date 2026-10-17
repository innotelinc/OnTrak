"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { classroomLink, classroomLinkRefusal } from "@/lib/classroom-rules";
import { httpLinkRefusal } from "@/lib/link-rules";
import { joinCode } from "@/lib/cohort-rules";
import { classAdmission } from "@/lib/program-admission";
import {
  awardProblems,
  completionProblems,
  courseSubmissionProblems,
  credentialProblems,
  foundationalContentProblems,
  moduleHourProblems,
  offeringSeatProblems,
  priceProblems,
  scheduleProblems,
  unrecognisedTopics,
} from "@/lib/program-rules";
import { canAdministerTenant, canCreateTenants, canManageTenant } from "@/lib/tenancy";

/**
 * Tenancies, the programs they run, and the classes inside those programs.
 *
 * The shape of this file follows the rest of the app's actions: a form posts, the action
 * refuses in words if it cannot, and it answers with a redirect carrying a flash. What is
 * new is that almost every action here has two questions to answer rather than one — *may
 * this person* do it, and *is this allowed* — and they are answered separately because
 * they fail differently: the first is a permission ("that tenancy is not yours"), the
 * second is a rule ("a slot may not exceed $1,800.00").
 *
 * The rules themselves live in `lib/program-rules.ts` and `lib/tenancy.ts`, as pure
 * functions, so the same arithmetic the form warns with is the arithmetic that refuses
 * here. A second copy of "$300 per instructional hour" in this file is the bug this is
 * arranged to prevent.
 */

/** The platform operator, who is the only account that may create a tenancy. */
async function requireOperator() {
  const user = await requireSession();
  if (!canCreateTenants(user)) {
    backTo("/admin/tenants", "Creating a tenancy is the platform operator's job.", false);
  }
  return user;
}

/** Someone who may change this tenancy: its own administrator, or the operator. */
async function requireTenantAdmin(organizationId: string) {
  const user = await requireSession();
  if (!canAdministerTenant(user, organizationId)) {
    backTo("/admin/tenants", "That tenancy is not one you administer.", false);
  }
  return user;
}

/**
 * Someone who may change a class in this tenancy: its own administrator or instructor, or
 * the operator. A narrower question than `requireTenantAdmin`'s, and a deliberately
 * different answer: the catalogue is the provider's (an administrator's to price), while the
 * person who teaches a class is the one who builds its classroom.
 */
async function requireTenantStaff(organizationId: string) {
  const user = await requireSession();
  if (!canManageTenant(user, organizationId)) {
    backTo("/instructor/cohorts", "That class is not one you teach.", false);
  }
  return user;
}

function backTo(path: string, message: string, ok = true): never {
  redirect(`${path}?${ok ? "flash" : "error"}=${encodeURIComponent(message)}`);
}

/** `$1,250` -> 125000. Empty is null, so an unset cap stays unset rather than becoming zero. */
function dollarsToCents(value: FormDataEntryValue | null): number | null {
  const raw = String(value ?? "").replace(/[$,\s]/g, "");
  if (raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

/** A date input's `YYYY-MM-DD`, at UTC midnight, or null when the field is empty. */
function dayField(value: FormDataEntryValue | null): Date | null {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  const parsed = new Date(`${raw.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A whole number a form asked for, or null.
 *
 * Zero is treated as unset rather than as a value: a program with a limit of zero courses, or
 * a cap of zero slots per employer, is a program nobody can take part in, and the empty field
 * is what a person actually leaves when they mean "no limit".
 */
function wholeField(value: FormDataEntryValue | null): number | null {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  const whole = Math.round(parsed);
  return whole > 0 ? whole : null;
}

/**
 * A textarea of one-per-line values, as the multi-value fields are written and read back.
 * Objectives on a module and topic areas on a course are both lists somebody types as a list;
 * storing them that way keeps the form that wrote them the thing that reads them.
 */
function listedValues(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/* -------------------------------------------------------------------------- */
/*  Tenancies                                                                  */
/* -------------------------------------------------------------------------- */

export async function createOrganization(formData: FormData): Promise<void> {
  const operator = await requireOperator();
  const name = String(formData.get("name") ?? "").trim();
  const programType = String(formData.get("programType") ?? "").trim() || null;
  const description = String(formData.get("description") ?? "").trim() || null;
  const city = String(formData.get("city") ?? "").trim() || null;
  const state = String(formData.get("state") ?? "").trim() || null;
  const kind = String(formData.get("kind") ?? "PROVIDER");
  const isPreRegistered = formData.get("isPreRegistered") === "on";
  const adminEmail = String(formData.get("adminEmail") ?? "").trim().toLowerCase();
  if (!name) backTo("/admin/tenants", "A tenancy needs a name.", false);

  // The slug is the tenant's stable identity in URLs, exports and report filenames, so a
  // collision is refused rather than silently suffixed: "mass-workforce-development" that
  // quietly became "-2" is a report nobody can find.
  const slug = slugify(String(formData.get("slug") ?? "").trim() || name);
  if (!slug) backTo("/admin/tenants", "That name has no letters or numbers to make a key from.", false);
  const existing = await prisma.organization.findUnique({ where: { slug } });
  if (existing) backTo("/admin/tenants", `The key “${slug}” is already taken.`, false);

  const organization = await prisma.organization.create({
    data: {
      name,
      slug,
      kind: kind === "EMPLOYER" || kind === "PLATFORM" ? kind : "PROVIDER",
      programType,
      description,
      city,
      state,
      isPreRegistered,
    },
  });

  /**
   * The tenancy's first administrator, if one was named.
   *
   * A tenancy nobody can sign into is a row, not an organisation: the person who runs the
   * program has to exist before its first class. An existing account is *moved* into the
   * tenancy rather than duplicated, because the family's unique key for a person is their
   * email and a second account would orphan the first one's history.
   */
  let adminNote = "";
  if (adminEmail) {
    const existingUser = await prisma.user.findUnique({ where: { email: adminEmail } });
    if (existingUser) {
      await prisma.user.update({
        where: { id: existingUser.id },
        data: { organizationId: organization.id, role: "ADMIN" },
      });
      adminNote = ` ${existingUser.name} was moved in as its administrator.`;
    } else {
      await prisma.user.create({
        data: {
          email: adminEmail,
          name: adminEmail.split("@")[0],
          role: "ADMIN",
          organizationId: organization.id,
        },
      });
      adminNote = ` ${adminEmail} is its administrator and can sign in through the identity provider.`;
    }
  }

  await recordAudit({
    actorId: operator.id,
    action: "organization.create",
    targetType: "organization",
    targetId: organization.id,
    detail: { name, slug, kind, programType },
  });

  revalidatePath("/admin/tenants");
  backTo(
    `/admin/tenants/${organization.id}`,
    `“${name}” created${programType ? ` for ${programType}` : ""}.${adminNote}`,
  );
}

export async function updateOrganization(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const user = await requireTenantAdmin(id);
  const name = String(formData.get("name") ?? "").trim();
  if (!name) backTo(`/admin/tenants/${id}`, "A tenancy needs a name.", false);

  await prisma.organization.update({
    where: { id },
    data: {
      name,
      programType: String(formData.get("programType") ?? "").trim() || null,
      description: String(formData.get("description") ?? "").trim() || null,
      displayName: String(formData.get("displayName") ?? "").trim() || null,
      accent: String(formData.get("accent") ?? "violet").trim() || "violet",
      city: String(formData.get("city") ?? "").trim() || null,
      state: String(formData.get("state") ?? "").trim() || null,
      isPreRegistered: formData.get("isPreRegistered") === "on",
      // The employer-side facts §4.2 asks for. They are blank on a provider, which is the
      // right answer for a provider: a FEIN is an employer's, and a memo is issued to one.
      fein: String(formData.get("fein") ?? "").trim() || null,
      eligibilityMemoExpiresOn: dayField(formData.get("eligibilityMemoExpiresOn")),
      // The provider's contact details for the directory's entries (§4.4). Unset on an
      // employer, which is the right answer for an employer.
      contactName: String(formData.get("contactName") ?? "").trim() || null,
      contactEmail: String(formData.get("contactEmail") ?? "").trim().toLowerCase() || null,
      contactPhone: String(formData.get("contactPhone") ?? "").trim() || null,
    },
  });
  await recordAudit({ actorId: user.id, action: "organization.update", targetType: "organization", targetId: id, detail: { name } });
  revalidatePath(`/admin/tenants/${id}`);
  backTo(`/admin/tenants/${id}`, "Saved.");
}

/* -------------------------------------------------------------------------- */
/*  Programs                                                                   */
/* -------------------------------------------------------------------------- */

export async function createProgram(formData: FormData): Promise<void> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const user = await requireTenantAdmin(organizationId);
  const name = String(formData.get("name") ?? "").trim();
  if (!name) backTo(`/admin/tenants/${organizationId}`, "A program needs a name.", false);

  const startsOn = dayField(formData.get("startsOn"));
  const endsOn = dayField(formData.get("endsOn"));
  if (startsOn && endsOn && endsOn < startsOn) {
    backTo(`/admin/tenants/${organizationId}`, "The program ends before it starts.", false);
  }

  // The contract is the period the per-employer cap is counted over, and it outlives the
  // window training is prioritised in — FAST AI signs on 2027-02-01 and runs to 2029-01-31
  // while training ends 2028-06-30. Kept separately so a cap cannot be counted over the
  // shorter of the two by accident.
  const contractStartsOn = dayField(formData.get("contractStartsOn"));
  const contractEndsOn = dayField(formData.get("contractEndsOn"));
  if (contractStartsOn && contractEndsOn && contractEndsOn < contractStartsOn) {
    backTo(`/admin/tenants/${organizationId}`, "The contract ends before it starts.", false);
  }

  const program = await prisma.program.create({
    data: {
      organizationId,
      name,
      funder: String(formData.get("funder") ?? "").trim() || null,
      fundName: String(formData.get("fundName") ?? "").trim() || null,
      startsOn,
      endsOn,
      awardCents: dollarsToCents(formData.get("award")),
      costPerHourCents: dollarsToCents(formData.get("costPerHour")),
      costPerPersonCents: dollarsToCents(formData.get("costPerPerson")),
      allocationCents: dollarsToCents(formData.get("allocation")),
      contractStartsOn: contractStartsOn,
      contractEndsOn: contractEndsOn,
      employerSlotCap: wholeField(formData.get("employerSlotCap")),
      maxCourses: wholeField(formData.get("maxCourses")),
      reportingCadence: String(formData.get("reportingCadence") ?? "").trim() || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
    },
  });

  await recordAudit({
    actorId: user.id,
    action: "program.create",
    targetType: "program",
    targetId: program.id,
    detail: { name, organizationId },
  });
  revalidatePath(`/admin/tenants/${organizationId}`);
  backTo(`/admin/tenants/${organizationId}`, `Program “${name}” created.`);
}

/* -------------------------------------------------------------------------- */
/*  Courses and their content                                                  */
/* -------------------------------------------------------------------------- */

export async function createCourse(formData: FormData): Promise<void> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const user = await requireTenantAdmin(organizationId);
  const programId = String(formData.get("programId") ?? "") || null;
  const title = String(formData.get("title") ?? "").trim();
  const summary = String(formData.get("summary") ?? "").trim() || null;
  const topicAreas = listedValues(formData.get("topicAreas"));
  // §3.3's remaining course details, held exactly as the form writes them: one per line for
  // the lists, free text for the rest.
  const aiTools = listedValues(formData.get("aiTools"));
  const courseNumber = wholeField(formData.get("courseNumber"));
  const maxSlotsPerOffering = wholeField(formData.get("maxSlotsPerOffering"));
  const text = (name: string) => String(formData.get(name) ?? "").trim() || null;
  const targetOccupations = text("targetOccupations");
  const targetIndustries = text("targetIndustries");
  const workplaceTasks = text("workplaceTasks");
  const credentials = text("credentials");
  const languages = text("languages");
  const instructionalHours = Number(String(formData.get("instructionalHours") ?? "").trim());
  const pricePerSlotCents = dollarsToCents(formData.get("pricePerSlot"));
  const back = `/admin/tenants/${organizationId}`;
  if (!title) backTo(back, "A course needs a title.", false);
  if (pricePerSlotCents === null) backTo(back, "A course needs a price per training slot.", false);

  // The program's ceilings, applied here with the same function the form warns with.
  const program = programId
    ? await prisma.program.findUnique({ where: { id: programId } })
    : await prisma.program.findFirst({ where: { organizationId }, orderBy: { createdAt: "asc" } });
  if (program) {
    const problems = priceProblems(
      { costPerHourCents: program.costPerHourCents, costPerPersonCents: program.costPerPersonCents },
      { title, instructionalHours, pricePerSlotCents },
    );
    if (problems.length > 0) backTo(back, problems[0].message, false);

    // What §3.3 asks a submitted course to say, refused here for the same reason the price is:
    // a course past the provider's 20-course limit is not considered, and a submission that
    // says nothing about its topic area cannot be placed in the directory.
    const courses = await prisma.course.count({ where: { organizationId, programId: program.id } });
    const numbered = await prisma.course.findMany({
      where: { organizationId, programId: program.id, courseNumber: { not: null } },
      select: { courseNumber: true },
    });
    const submission = courseSubmissionProblems({
      title,
      description: summary,
      topicAreas,
      courses: courses + 1,
      maxCourses: program.maxCourses,
      courseNumber,
      aiTools,
      targetOccupations,
      targetIndustries,
      workplaceTasks,
      maxSlotsPerOffering,
      takenNumbers: numbered
        .map((entry) => entry.courseNumber)
        .filter((value): value is number => value !== null),
    });
    if (submission.length > 0) backTo(back, submission[0].message, false);
  }

  // The funder's answers on course content, refused here for the same reason the price is.
  // Material it does not fund cannot be submitted at all, and a credential the provider issues
  // itself is not one the RFQ counts; both are cheaper to refuse than to lose at review.
  const tenant = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true },
  });
  const content = [
    ...foundationalContentProblems({ title, text: [summary] }),
    ...credentialProblems({ title, credentials, provider: tenant?.name ?? "" }),
  ];
  if (content.length > 0) backTo(back, content[0].message, false);

  const course = await prisma.course.create({
    data: {
      organizationId,
      programId: program?.id ?? null,
      title,
      summary,
      deliveryMode: String(formData.get("deliveryMode") ?? "instructor-led").trim() || "instructor-led",
      instructionalHours,
      pricePerSlotCents,
      audience: String(formData.get("audience") ?? "").trim() || null,
      prerequisites: String(formData.get("prerequisites") ?? "").trim() || null,
      topicAreas: topicAreas.join("\n") || null,
      courseNumber,
      aiTools: aiTools.join("\n") || null,
      targetOccupations,
      targetIndustries,
      workplaceTasks,
      credentials,
      languages,
      maxSlotsPerOffering,
      // Deliberately no `directoryApprovedAt`: "Awarded courses are not published to the
      // directory on the basis of the RFQ response alone" (§4.3), so a new course is a draft
      // until CommCorp's review is recorded on its card (`setListingState`).
    },
  });

  await recordAudit({ actorId: user.id, action: "course.create", targetType: "course", targetId: course.id, detail: { title } });
  revalidatePath(back);
  const outside = unrecognisedTopics(topicAreas);
  backTo(
    back,
    `Course “${title}” added to the catalogue.${
      outside.length > 0
        ? ` ${outside.map((area) => `“${area}”`).join(", ")} ${
            outside.length === 1 ? "is" : "are"
          } not on the RFQ's in-scope list; §3.2 considers other AI-related topics as needed, so confirm ${outside.length === 1 ? "it" : "them"} with the funder.`
        : ""
    }`,
  );
}

/**
 * One module of a course: the authored content the RFQ asks a provider to be able to show.
 *
 * The objectives are one per line because that is how a syllabus is written and how it is
 * read back — a single paragraph of objectives is a paragraph, not a list somebody can
 * teach from or mark against.
 */
export async function addCourseModule(formData: FormData): Promise<void> {
  const courseId = String(formData.get("courseId") ?? "");
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course) backTo("/admin/tenants", "That course no longer exists.", false);
  const user = await requireTenantAdmin(course.organizationId);
  const title = String(formData.get("title") ?? "").trim();
  const hours = Number(String(formData.get("hours") ?? "").trim());
  const objectives = String(formData.get("objectives") ?? "").trim();
  const back = `/admin/tenants/${course.organizationId}`;
  if (!title) backTo(back, "A module needs a title.", false);
  if (!objectives) backTo(back, "A module needs at least one objective.", false);

  // The module is where a course would actually spend an hour on device setup, account access
  // or browser use, and the funder answered that those are foundational rather than funded
  // content (RFQ answers, 2026-10-13, §3). Refused at authoring, not after the course is built.
  const activity = String(formData.get("activity") ?? "").trim() || null;
  const outcome = String(formData.get("outcome") ?? "").trim() || null;
  const content = foundationalContentProblems({
    title: `${course.title} — ${title}`,
    text: [title, objectives, activity, outcome],
  });
  if (content.length > 0) backTo(back, content[0].message, false);

  const last = await prisma.courseModule.findFirst({ where: { courseId }, orderBy: { position: "desc" } });
  await prisma.courseModule.create({
    data: {
      courseId,
      position: (last?.position ?? 0) + 1,
      title,
      hours: Number.isFinite(hours) && hours > 0 ? hours : 1,
      objectives,
      activity,
      outcome,
    },
  });
  await recordAudit({ actorId: user.id, action: "course.module", targetType: "course", targetId: courseId, detail: { title } });
  revalidatePath(back);
  backTo(back, `Module “${title}” added.`);
}

/* -------------------------------------------------------------------------- */
/*  The funder's directory                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where a course stands with the funder's course directory (§4.3, §4.4).
 *
 * Three states rather than a checkbox, because all three happen: a course drafted by the
 * provider, one CommCorp has reviewed and published, and one taken down again — "CommCorp
 * reserves the right to remove or suspend a course listing at will", and the provider is the
 * one keeping the record. Publishing keeps the original approval date if there was one, so the
 * history of when it entered the directory is not rewritten by a re-publication.
 */
export async function setListingState(formData: FormData): Promise<void> {
  const courseId = String(formData.get("courseId") ?? "");
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    include: { modules: { orderBy: { position: "asc" } } },
  });
  if (!course) backTo("/admin/tenants", "That course no longer exists.", false);
  const user = await requireTenantAdmin(course.organizationId);
  const back = `/admin/tenants/${course.organizationId}`;
  const requested = String(formData.get("state") ?? "draft");
  const state = requested === "published" || requested === "suspended" ? requested : "draft";
  const note = String(formData.get("note") ?? "").trim() || null;

  // Only instructor-led time may be listed, counted and priced, so a course whose modules do
  // not add up to the hours it states is not something the funder's directory can carry. The
  // check is here rather than on `addCourseModule` because a course is written module by
  // module: the total is only meaningful once the provider says it is finished.
  if (state === "published") {
    const hours = moduleHourProblems({
      title: course.title,
      instructionalHours: course.instructionalHours,
      modules: course.modules.map((module) => ({ title: module.title, hours: module.hours })),
    });
    if (hours.length > 0) backTo(back, hours[0].message, false);
  }
  const approved = state === "draft" ? null : (course.directoryApprovedAt ?? new Date());

  await prisma.course.update({
    where: { id: courseId },
    data: {
      directoryApprovedAt: approved,
      listingSuspendedAt: state === "suspended" ? new Date() : null,
      listingNote: state === "suspended" ? note : null,
    },
  });

  await recordAudit({
    actorId: user.id,
    action: "course.listing",
    targetType: "course",
    targetId: courseId,
    detail: { state, note },
  });
  revalidatePath(back);
  backTo(
    back,
    state === "published"
      ? `“${course.title}” is listed in the funder's directory.`
      : state === "suspended"
        ? `“${course.title}”'s listing is taken down${note ? `: ${note}` : ""}.`
        : `“${course.title}” is a draft again, out of the directory.`,
  );
}

/* -------------------------------------------------------------------------- */
/*  Classes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Schedule a class inside a program.
 *
 * Both rule sets run before anything is written, and both are the funder's rather than
 * this app's: the window (training starts on or after 2027-02-01 and is complete by
 * 2028-06-30), the funded delivery (instructor-led), and the money (a slot within the
 * per-hour and per-person ceilings, and the whole class within the award).
 */
export async function scheduleClass(formData: FormData): Promise<void> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const user = await requireTenantAdmin(organizationId);
  const courseId = String(formData.get("courseId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const startsOn = dayField(formData.get("startsOn"));
  const endsOn = dayField(formData.get("endsOn"));
  const seatsRaw = String(formData.get("seats") ?? "").trim();
  const seats = seatsRaw === "" ? null : Number(seatsRaw);
  const deliveryMode = String(formData.get("deliveryMode") ?? "instructor-led");
  const back = `/admin/tenants/${organizationId}`;

  const course = await prisma.course.findUnique({ where: { id: courseId }, include: { program: true } });
  if (!course) backTo(back, "Pick a course from the catalogue first.", false);
  if (!name) backTo(back, "A class needs a name.", false);

  const priceOverride = dollarsToCents(formData.get("pricePerSlot"));
  const pricePerSlotCents = priceOverride ?? course.pricePerSlotCents;

  const programCaps = {
    costPerHourCents: course.program?.costPerHourCents ?? null,
    costPerPersonCents: course.program?.costPerPersonCents ?? null,
    startsOn: course.program?.startsOn ?? null,
    endsOn: course.program?.endsOn ?? null,
  };
  const problems = [
    ...priceProblems(programCaps, { title: course.title, instructionalHours: course.instructionalHours, pricePerSlotCents }),
    ...scheduleProblems(programCaps, { name, startsOn, endsOn, seats, deliveryMode }),
    ...awardProblems(course.program?.awardCents ?? null, { name, seats, pricePerSlotCents }),
    // The course's own ceiling on an offering (§3.3): a class that seats more than it was
    // submitted for is a class the funder was never asked to fund.
    ...offeringSeatProblems(course, { name, seats }),
  ];
  if (problems.length > 0) backTo(back, problems[0].message, false);

  const sponsorOrganizationId = String(formData.get("sponsorOrganizationId") ?? "") || null;
  const cohort = await prisma.cohort.create({
    data: {
      name,
      description: String(formData.get("description") ?? "").trim() || null,
      joinCode: joinCode(),
      instructorId: user.id,
      organizationId,
      programId: course.programId,
      courseId: course.id,
      sponsorOrganizationId,
      startsOn,
      endsOn,
      instructionalHours: course.instructionalHours,
      seats: seats === null || Number.isNaN(seats) ? null : seats,
      pricePerSlotCents,
      deliveryMode,
      location: String(formData.get("location") ?? "").trim() || null,
    },
  });

  await recordAudit({
    actorId: user.id,
    action: "class.schedule",
    targetType: "cohort",
    targetId: cohort.id,
    detail: { name, courseId: course.id, seats, pricePerSlotCents },
  });
  revalidatePath(back);
  backTo(back, `Class “${name}” scheduled — join code ${cohort.joinCode}.`);
}

/**
 * Enrol a learner, creating their account in this tenancy when they do not have one.
 *
 * Enrolment writes two rows on purpose: the `Enrollment` that the funder's report reads
 * (status, hours, completion) and the `CohortMember` that the class roster and every
 * existing assignment already use. One of them alone would mean either the reporting is
 * empty or the student cannot see their class.
 *
 * A class inside a funded program carries the funder's admission rules, all of them answered
 * before anything is written because §4.2 puts the risk of getting them wrong on the provider:
 * *"Slots delivered to ineligible employers, or in excess of the cap, are not reimbursable, and
 * the selected Applicant carries that risk."* The sponsoring employer has to exist, hold a
 * current eligibility confirmation memo for the day the slot is delivered, and still have room
 * under the program's per-employer cap. That is `classAdmission`, which is also what the sign-up
 * form asks — this page is one of two doors into a class, and the rules are the same at both.
 */
export async function enrollLearner(formData: FormData): Promise<void> {
  const cohortId = String(formData.get("cohortId") ?? "");
  const cohort = await prisma.cohort.findUnique({ where: { id: cohortId } });
  if (!cohort || !cohort.organizationId) backTo("/admin/tenants", "That class no longer exists.", false);
  const user = await requireTenantAdmin(cohort.organizationId);
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim();
  const back = `/admin/tenants/${cohort.organizationId}`;
  if (!email) backTo(back, "An enrolment needs an email address.", false);

  // An offering may include participants the program does not fund (RFQ answers, 2026-10-13,
  // §2.2). Such a seat is still a seat in the class, but it is nobody's cap and nobody's
  // reimbursement, so the flag is what the report and the per-employer arithmetic read.
  const funded = String(formData.get("funded") ?? "true") !== "false";

  const admission = await classAdmission(cohort);
  if (admission.length > 0) backTo(back, admission[0].message, false);

  const learner = await prisma.user.upsert({
    where: { email },
    update: { organizationId: cohort.organizationId },
    create: {
      email,
      name: name || email.split("@")[0],
      role: "STUDENT",
      organizationId: cohort.organizationId,
    },
  });

  await prisma.enrollment.upsert({
    where: { cohortId_userId: { cohortId, userId: learner.id } },
    update: { funded },
    create: {
      cohortId,
      userId: learner.id,
      funded,
      organizationId: cohort.organizationId,
      sponsorOrganizationId: cohort.sponsorOrganizationId,
    },
  });
  await prisma.cohortMember.upsert({
    where: { cohortId_userId: { cohortId, userId: learner.id } },
    update: {},
    create: { cohortId, userId: learner.id },
  });

  await recordAudit({ actorId: user.id, action: "enrollment.create", targetType: "cohort", targetId: cohortId, detail: { email } });
  revalidatePath(back);
  backTo(back, `${learner.name} is enrolled in “${cohort.name}”.`);
}

/**
 * Record one sitting.
 *
 * The learner's attended hours are summed onto the enrolment row rather than counted at
 * report time: the report has to state hours per learner per class, and a sum that is
 * recomputed in two places is a sum that eventually disagrees with itself.
 */
export async function recordAttendance(formData: FormData): Promise<void> {
  const enrollmentId = String(formData.get("enrollmentId") ?? "");
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId } });
  if (!enrollment) backTo("/admin/tenants", "That enrolment no longer exists.", false);
  const user = await requireTenantAdmin(enrollment.organizationId);
  const sessionDate = dayField(formData.get("sessionDate"));
  const status = String(formData.get("status") ?? "PRESENT");
  const hours = Number(String(formData.get("hours") ?? "0"));
  const back = `/admin/tenants/${enrollment.organizationId}`;
  if (!sessionDate) backTo(back, "A sitting needs a date.", false);

  await prisma.attendance.upsert({
    where: { enrollmentId_sessionDate: { enrollmentId, sessionDate } },
    update: { status: status === "ABSENT" || status === "EXCUSED" ? status : "PRESENT", hours: Number.isFinite(hours) ? hours : 0 },
    create: {
      enrollmentId,
      organizationId: enrollment.organizationId,
      sessionDate,
      status: status === "ABSENT" || status === "EXCUSED" ? status : "PRESENT",
      hours: Number.isFinite(hours) ? hours : 0,
      note: String(formData.get("note") ?? "").trim() || null,
    },
  });

  const totals = await prisma.attendance.aggregate({
    where: { enrollmentId, status: "PRESENT" },
    _sum: { hours: true },
  });
  const hoursAttended = totals._sum.hours ?? 0;
  const attendedAny = await prisma.attendance.count({ where: { enrollmentId, status: "PRESENT" } });
  await prisma.enrollment.update({
    where: { id: enrollmentId },
    data: {
      hoursAttended,
      // A learner who has sat a session is no longer merely enrolled; one who has completed
      // the course keeps that, because completion is a decision somebody records, not an
      // arithmetic consequence of showing up.
      status: enrollment.status === "COMPLETED" || enrollment.status === "WITHDRAWN"
        ? enrollment.status
        : attendedAny > 0
          ? "ATTENDED"
          : "ENROLLED",
    },
  });

  await recordAudit({ actorId: user.id, action: "attendance.record", targetType: "enrollment", targetId: enrollmentId, detail: { hours, status } });
  revalidatePath(back);
  backTo(back, `Attendance recorded: ${hours} hour(s).`);
}

/**
 * Record — or clear — that a learner completed the course's required assessment.
 *
 * A separate decision from attendance because the funder's answer separates them: the hours
 * prove the training happened, and this proves the learner did the thing the course assesses
 * (RFQ answers, 2026-10-13, §4). It is a timestamp rather than a checkbox so the record says
 * when the provider saw it, which is what an auditor asks.
 */
export async function setAssessment(formData: FormData): Promise<void> {
  const enrollmentId = String(formData.get("enrollmentId") ?? "");
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId } });
  if (!enrollment) backTo("/admin/tenants", "That enrolment no longer exists.", false);
  const user = await requireTenantAdmin(enrollment.organizationId);
  const back = `/admin/tenants/${enrollment.organizationId}`;
  const recorded = String(formData.get("done") ?? "record") !== "clear";

  await prisma.enrollment.update({
    where: { id: enrollmentId },
    data: { assessmentRecordedAt: recorded ? (enrollment.assessmentRecordedAt ?? new Date()) : null },
  });

  await recordAudit({
    actorId: user.id,
    action: "enrollment.assessment",
    targetType: "enrollment",
    targetId: enrollmentId,
    detail: { recorded },
  });
  revalidatePath(back);
  backTo(
    back,
    recorded
      ? "Assessment recorded — the completion can now be reimbursed."
      : "Assessment cleared; a completion without one is not reimbursable.",
  );
}

/**
 * Mark a learner complete, or withdraw them. Both are decisions, so both are recorded.
 *
 * A completion is also the slot the cap spends and the report bills, so it is checked against
 * the funder's own test before it is written: all the course's instructional hours attended
 * (recorded as a make-up or with another cohort of the same course, if that is how it was
 * earned), and no earlier completed slot for the same trainee and course — "A slot may be
 * reimbursed only once per trainee per course" (RFQ answers, 2026-10-13, §4). A completion
 * that fails is a slot the provider would bill for and CommCorp would not pay for.
 */
export async function setEnrollmentStatus(formData: FormData): Promise<void> {
  const enrollmentId = String(formData.get("enrollmentId") ?? "");
  const enrollment = await prisma.enrollment.findUnique({
    where: { id: enrollmentId },
    include: { user: true, cohort: { include: { course: true } } },
  });
  if (!enrollment) backTo("/admin/tenants", "That enrolment no longer exists.", false);
  const user = await requireTenantAdmin(enrollment.organizationId);
  const requested = String(formData.get("status") ?? "COMPLETED");
  const status = requested === "WITHDRAWN" ? "WITHDRAWN" : requested === "ENROLLED" ? "ENROLLED" : "COMPLETED";
  const back = `/admin/tenants/${enrollment.organizationId}`;

  // The completion test is the funder's and applies to the seat it pays for. An unfunded
  // participant still finishes the class, and their row says so without being a claim on money.
  const course = enrollment.cohort.course;
  if (status === "COMPLETED" && course && enrollment.funded) {
    const prior = await prisma.enrollment.count({
      where: {
        userId: enrollment.userId,
        organizationId: enrollment.organizationId,
        status: "COMPLETED",
        id: { not: enrollmentId },
        cohort: { courseId: course.id },
      },
    });
    const problems = completionProblems(
      { title: course.title, instructionalHours: course.instructionalHours },
      {
        learnerEmail: enrollment.user.email,
        hoursAttended: enrollment.hoursAttended,
        // The assessment is a fact somebody records, so the field being set is the record.
        assessmentComplete: enrollment.assessmentRecordedAt !== null,
        priorReimbursements: prior,
      },
    );
    if (problems.length > 0) backTo(back, problems[0].message, false);
  }

  await prisma.enrollment.update({
    where: { id: enrollmentId },
    data: {
      status,
      completedAt: status === "COMPLETED" ? (enrollment.completedAt ?? new Date()) : null,
    },
  });

  await recordAudit({ actorId: user.id, action: "enrollment.status", targetType: "enrollment", targetId: enrollmentId, detail: { status } });
  revalidatePath(back);
  backTo(
    back,
    status === "COMPLETED" ? "Completion recorded." : `Enrolment marked ${status.toLowerCase()}.`,
  );
}

/**
 * Record — or clear — the funder's two feedback instruments for one class (§4.5).
 *
 * CommCorp collects trainee and employer feedback and the provider's part is to facilitate
 * access, so a class carries the two addresses the surveys are sent out under. An empty field is
 * how one is taken down, and both are validated as addresses before anything is stored: the
 * trainee survey link is the one address on a class that goes to a *learner*, and a stored
 * `javascript:` URL there would run as the person who clicked it.
 *
 * The same permission as the classroom: the instructor who teaches the class may keep its
 * feedback addresses, and the tenancy's administrator may change any of them.
 */
export async function setClassFeedback(formData: FormData): Promise<void> {
  const cohortId = String(formData.get("cohortId") ?? "");
  const cohort = await prisma.cohort.findUnique({ where: { id: cohortId } });
  if (!cohort || !cohort.organizationId) {
    backTo("/admin/tenants", "That class no longer exists.", false);
  }
  const user = await requireTenantStaff(cohort.organizationId);
  const staffOnly = !canAdministerTenant(user, cohort.organizationId);
  const back = staffOnly ? "/instructor/cohorts" : `/admin/tenants/${cohort.organizationId}`;

  const rawTrainee = String(formData.get("traineeSurveyUrl") ?? "");
  const rawEmployer = String(formData.get("employerSurveyUrl") ?? "");
  const trainee = rawTrainee.trim() === "" ? null : classroomLink(rawTrainee);
  if (rawTrainee.trim() !== "" && trainee === null) {
    backTo(back, httpLinkRefusal(rawTrainee, "trainee survey"), false);
  }
  const employer = rawEmployer.trim() === "" ? null : classroomLink(rawEmployer);
  if (rawEmployer.trim() !== "" && employer === null) {
    backTo(back, httpLinkRefusal(rawEmployer, "employer survey"), false);
  }

  await prisma.cohort.update({
    where: { id: cohortId },
    data: { traineeSurveyUrl: trainee, employerSurveyUrl: employer },
  });
  await recordAudit({
    actorId: user.id,
    action: "class.feedback",
    targetType: "cohort",
    targetId: cohortId,
    detail: { trainee, employer },
  });
  revalidatePath("/instructor/cohorts");
  if (!staffOnly) revalidatePath(back);
  const missing = [trainee === null ? "trainee" : null, employer === null ? "employer" : null].filter(Boolean);
  backTo(
    back,
    missing.length === 0
      ? `“${cohort.name}” has both feedback surveys recorded.`
      : `“${cohort.name}”: the ${missing.join(" and ")} survey ${
          missing.length === 1 ? "is" : "are"
        } not recorded yet.`,
  );
}

/* -------------------------------------------------------------------------- */
/*  AI classrooms                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Attach — or take down — the AI classroom a course or a class is taught with.
 *
 * Two rows can carry one, and which of them does depends on the question being asked. A
 * course's classroom is the one generated from its own modules, shared by every class of
 * it; a class's own is the sitting's, built say from the sponsoring employer's documents.
 * The class's wins, and that comparison is `effectiveClassroom`'s rather than this
 * action's, so the form, the two pages that read it and the tests cannot disagree about
 * which classroom a learner is offered.
 *
 * Three refusals, all before anything is written:
 *
 *   - the row belongs to no tenancy this person may change — an ADMIN for a course, whose
 *     price and material are the provider's, and an ADMIN *or* the instructor who teaches
 *     it for a class, because the person in the room is who builds the classroom;
 *   - the address is not an absolute http(s) URL, or carries a username and password.
 *     `classroomLink` decides that, and it is the same function the page renders through: a
 *     stored `javascript:` URL is script execution in the reader's own session, and a
 *     password in a field every member of the class can read is not a secret;
 *   - the row no longer exists.
 *
 * An empty address is not an error: it is how a classroom is taken back down, and it is
 * audited as a removal rather than a save, so the trail says which of the two happened.
 */
export async function setClassroom(formData: FormData): Promise<void> {
  const target = String(formData.get("target") ?? "course") === "class" ? "class" : "course";
  const id = String(formData.get("id") ?? "");
  const raw = String(formData.get("classroomUrl") ?? "");

  const course = target === "course" ? await prisma.course.findUnique({ where: { id } }) : null;
  const klass = target === "class" ? await prisma.cohort.findUnique({ where: { id } }) : null;
  const organizationId = course?.organizationId ?? klass?.organizationId ?? null;
  if (!organizationId) {
    backTo("/admin/tenants", "That course or class no longer exists, or belongs to no tenancy.", false);
  }

  const user = course ? await requireTenantAdmin(organizationId) : await requireTenantStaff(organizationId);
  // Where the answer goes. A course is the catalogue's, which is an administrator's page; a
  // class may also be changed by the instructor who teaches it, and their answer belongs on
  // their own classes page rather than on one they cannot open.
  const staffOnly = course === null && !canAdministerTenant(user, organizationId);
  const back = staffOnly ? "/instructor/cohorts" : `/admin/tenants/${organizationId}`;
  const revalidate = () => {
    revalidatePath("/instructor/cohorts");
    if (!staffOnly) revalidatePath(back);
  };
  const save = async (value: string | null) => {
    if (course) await prisma.course.update({ where: { id }, data: { classroomUrl: value } });
    else if (klass) await prisma.cohort.update({ where: { id }, data: { classroomUrl: value } });
  };
  const audit = { actorId: user.id, targetType: course ? "course" : "cohort", targetId: id };

  if (raw.trim() === "") {
    await save(null);
    await recordAudit({ ...audit, action: "classroom.detach", detail: { target } });
    revalidate();
    backTo(back, "AI classroom removed.");
  }

  const url = classroomLink(raw);
  if (url === null) backTo(back, classroomLinkRefusal(raw), false);

  await save(url);
  await recordAudit({ ...audit, action: "classroom.attach", detail: { target, url } });
  revalidate();
  backTo(
    back,
    course
      ? `“${course.title}” now teaches its AI classroom to every class of it.`
      : `“${klass?.name}” has its own AI classroom for this sitting.`,
  );
}
