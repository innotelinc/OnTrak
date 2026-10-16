import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { canAdministerTenant } from "@/lib/tenancy";
import {
  addCourseModule,
  createCourse,
  createProgram,
  enrollLearner,
  recordAttendance,
  scheduleClass,
  setClassFeedback,
  setClassroom,
  setEnrollmentStatus,
  setListingState,
  updateOrganization,
} from "@/app/actions/tenants";
import {
  eligibilityProblems,
  employerSlotUsage,
  money,
  slotCeilingCents,
  unrecognisedTopics,
  type EmployerSlotRow,
  type EmployerSlotUsage,
  type RuleProblem,
} from "@/lib/program-rules";
import { reportRows, reportSummary } from "@/lib/program-report";
import {
  directoryState,
  listingProblems,
  providerContactProblems,
  type ProviderContact,
} from "@/lib/directory-rules";
import { feedbackGaps, feedbackLinks, feedbackSummary } from "@/lib/feedback-rules";
import {
  classroomConfigFromEnv,
  classroomHomeUrl,
  classroomProblems,
  classroomSpec,
  classroomSpecFilename,
  classroomSpecJson,
  effectiveClassroom,
  type ClassroomConfig,
  type ClassroomSpecInput,
  type EffectiveClassroom,
} from "@/lib/classroom-rules";
import { Flash, PageHeader } from "@/components/PageHeader";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  Stat,
  Textarea,
  Toggle,
} from "@/components/ui";

export const metadata: Metadata = { title: "Tenancy" };

const day = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : "—");

const ENROLMENT_TONE = {
  ENROLLED: "neutral",
  ATTENDED: "sky",
  COMPLETED: "teal",
  WITHDRAWN: "danger",
} as const;

async function loadTenant(id: string) {
  return prisma.organization.findUnique({
    where: { id },
    include: {
      programs: { orderBy: { createdAt: "asc" } },
      courses: {
        orderBy: { createdAt: "asc" },
        include: { modules: { orderBy: { position: "asc" } } },
      },
      classes: {
        orderBy: [{ startsOn: "asc" }, { createdAt: "asc" }],
        include: {
          // The course *and* its modules: a class's classroom is generated from the same
          // material a course-level one is, so the class card can offer the same spec.
          course: { include: { modules: { orderBy: { position: "asc" } } } },
          program: { select: { id: true, name: true, funder: true, employerSlotCap: true } },
          // The sponsor's eligibility, not just its name: whether a worker may be enrolled at
          // all turns on the memo and the FEIN, so the class card has to be able to say so.
          sponsor: {
            select: {
              id: true,
              name: true,
              isPreRegistered: true,
              fein: true,
              eligibilityMemoExpiresOn: true,
            },
          },
          enrollments: {
            orderBy: { enrolledAt: "asc" },
            include: {
              user: { select: { id: true, name: true, email: true } },
              attendances: { orderBy: { sessionDate: "asc" } },
            },
          },
        },
      },
      users: { orderBy: [{ role: "asc" }, { name: "asc" }], select: { id: true, name: true, email: true, role: true } },
    },
  });
}

type Tenant = NonNullable<Awaited<ReturnType<typeof loadTenant>>>;
type TenantClass = Tenant["classes"][number];
type TenantCourse = Tenant["courses"][number];

/**
 * A tenancy, seen from the platform: what it trains for, the program that funds it, the
 * catalogue the funder's directory can list, and the classes with the people in them.
 *
 * Everything on this page is one organisation's, which is the point of the tenancy: the
 * Massachusetts Workforce Development program's classes, seats and learners are not mixed
 * into anyone else's figures, and the CommCorp report it exports says so.
 */
export default async function TenantPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const { id } = await params;
  const { flash, error } = await searchParams;
  const viewer = await requireSession();

  if (!canAdministerTenant(viewer, id)) {
    redirect(`/admin/tenants?error=${encodeURIComponent("That tenancy is not one you administer.")}`);
  }

  const tenant = await loadTenant(id);
  if (!tenant) notFound();

  const sponsors = await prisma.organization.findMany({
    where: { id: { not: tenant.id } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, kind: true },
  });

  const program = tenant.programs[0] ?? null;
  // The classroom host this deployment serves, if any. Read once and passed down: the
  // panels below are presentation, and two of them deciding separately where the classroom
  // is would be two answers to one question.
  const classroom = classroomConfigFromEnv();
  const classroomHome = classroomHomeUrl(classroom);
  // The page's figures are the export's figures: one row per learner per class, through the same
  // builder the CSV route uses, then through the same totals. A page that added up differently
  // from the file it offers to download is a page a provider would stop trusting.
  const summary = reportSummary(reportRows({ organization: tenant, classes: tenant.classes }));
  const seats = tenant.classes.reduce((sum, klass) => sum + (klass.seats ?? 0), 0);

  // The directory (§4.3, §4.4): the provider's contact details are one block for the whole
  // catalogue, and each course's listing state is its own.
  const contact: ProviderContact = {
    providerName: tenant.name,
    contactName: tenant.contactName,
    contactEmail: tenant.contactEmail,
    contactPhone: tenant.contactPhone,
  };
  const contactProblems = providerContactProblems(contact);
  const listings = tenant.courses.map((course) => ({
    course,
    state: directoryState(course),
    problems: listingProblems(course),
  }));
  const publishedCount = listings.filter((entry) => entry.state === "published").length;

  /**
   * Slot usage per employer *per program*.
   *
   * The funder's cap is per employer per approved Applicant over the contract term, so it is
   * counted across every class of the program rather than per class: an employer is not at 96
   * of its 100 slots because one class is small, it is at 96 because ninety-six of its people
   * have been trained. Keyed by program as well, because a provider running two funded programs
   * has two contracts and two caps.
   */
  const usageByEmployer = new Map<string, EmployerSlotUsage>();
  for (const entry of tenant.programs) {
    const slotRows: EmployerSlotRow[] = tenant.classes
      .filter((klass) => klass.programId === entry.id)
      .flatMap((klass) =>
        klass.enrollments.map((enrollment) => ({
          employerId: klass.sponsorOrganizationId,
          employerName: klass.sponsor?.name ?? null,
          enrolledOn: enrollment.enrolledAt,
          status: enrollment.status,
          present: enrollment.attendances.filter((sitting) => sitting.status === "PRESENT").length,
          pricePerSlotCents: klass.pricePerSlotCents,
        })),
      );
    for (const usage of employerSlotUsage(slotRows, entry.employerSlotCap)) {
      usageByEmployer.set(`${entry.id}:${usage.employerId}`, usage);
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow={tenant.programType ?? "Tenancy"}
        title={tenant.name}
        description={
          <span className="font-mono text-xs text-ink-faint">
            {tenant.slug}
            {tenant.city && tenant.state ? ` · ${tenant.city}, ${tenant.state}` : ""}
          </span>
        }
        actions={
          <>
            <Link
              href="/admin/tenants"
              className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-xs font-semibold text-ink-soft transition hover:text-ink"
            >
              All tenancies
            </Link>
            <Link
              href={`/admin/tenants/${tenant.id}/directory`}
              className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-xs font-semibold text-ink-soft transition hover:text-ink"
            >
              Directory listings (CSV)
            </Link>
            <Link
              href={`/admin/tenants/${tenant.id}/report`}
              className="rounded-full gradient-brand px-3.5 py-1.5 text-xs font-semibold text-white"
            >
              CommCorp report (CSV)
            </Link>
          </>
        }
      />
      <Flash flash={flash} error={error} />

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Classes" value={tenant.classes.length} hint={`${seats} seats offered`} tone="brand" />
        <Stat
          label="Enrolments"
          value={summary.enrolments}
          hint={`${summary.completed} completed · ${summary.withdrawn} withdrawn`}
          tone="teal"
        />
        <Stat label="Courses" value={tenant.courses.length} hint="in the published catalogue" tone="sky" />
        <Stat
          label="Reimbursable"
          value={money(summary.reimbursableCents)}
          hint={`${money(summary.committedCents)} committed · ${
            program?.awardCents ? `of ${money(program.awardCents)} award` : "no award ceiling set"
          }`}
          tone="pink"
        />
      </div>

      {/* ------------------------------------------------------------- tenancy facts */}
      <section className="mt-8">
        <details className="card-surface rounded-xl2 p-5">
          <summary className="cursor-pointer font-display text-lg font-semibold text-ink">
            Tenancy details
          </summary>
          <form action={updateOrganization} className="mt-4 grid gap-4 md:grid-cols-2">
            <input type="hidden" name="id" value={tenant.id} />
            <Field label="Name" htmlFor="name">
              <Input id="name" name="name" defaultValue={tenant.name} required />
            </Field>
            <Field label="Trains for" htmlFor="programType">
              <Input id="programType" name="programType" defaultValue={tenant.programType ?? ""} />
            </Field>
            <Field label="Display name" htmlFor="displayName" hint="optional">
              <Input id="displayName" name="displayName" defaultValue={tenant.displayName ?? ""} />
            </Field>
            <Field label="Accent" htmlFor="accent">
              <Select id="accent" name="accent" defaultValue={tenant.accent}>
                {["violet", "teal", "amber", "pink", "sky", "lime"].map((accent) => (
                  <option key={accent} value={accent}>
                    {accent}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="City" htmlFor="city">
              <Input id="city" name="city" defaultValue={tenant.city ?? ""} />
            </Field>
            <Field label="State" htmlFor="state">
              <Input id="state" name="state" defaultValue={tenant.state ?? ""} maxLength={2} />
            </Field>
            {/* The employer's two compliance facts. Blank on a provider, which is the right
                answer for a provider: a FEIN is an employer's, and a memo is issued to one. */}
            <Field label="FEIN" htmlFor="fein" hint="employers only">
              <Input id="fein" name="fein" defaultValue={tenant.fein ?? ""} placeholder="04-1234567" />
            </Field>            <Field label="Eligibility memo expires" htmlFor="eligibilityMemoExpiresOn" hint="employers only">
              <Input
                id="eligibilityMemoExpiresOn"
                name="eligibilityMemoExpiresOn"
                type="date"
                defaultValue={tenant.eligibilityMemoExpiresOn ? day(tenant.eligibilityMemoExpiresOn) : ""}
              />
            </Field>
            {/* The directory's contact block (§4.4): who an employer should ask for, and how. */}
            <Field label="Directory contact" htmlFor="contactName" hint="providers only">
              <Input id="contactName" name="contactName" defaultValue={tenant.contactName ?? ""} placeholder="Program director" />
            </Field>
            <Field label="Contact email" htmlFor="contactEmail" hint="providers only">
              <Input
                id="contactEmail"
                name="contactEmail"
                type="email"
                defaultValue={tenant.contactEmail ?? ""}
                placeholder="training@example.org"
              />
            </Field>
            <Field label="Contact phone" htmlFor="contactPhone" hint="optional">
              <Input id="contactPhone" name="contactPhone" defaultValue={tenant.contactPhone ?? ""} placeholder="617-555-0100" />
            </Field>
            <Field label="Description" htmlFor="description" className="md:col-span-2" hint="optional">
              <Textarea id="description" name="description" rows={2} defaultValue={tenant.description ?? ""} />
            </Field>
            <div className="md:col-span-2">
              <Toggle
                name="isPreRegistered"
                defaultChecked={tenant.isPreRegistered}
                label="Pre-registered with the funder"
                description="FAST AI only pays for an employer CommCorp has pre-registered."
              />
            </div>
            <div className="md:col-span-2">
              <Button type="submit">Save</Button>
            </div>
          </form>
        </details>
      </section>

      {/* ------------------------------------------------------------------- programs */}
      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold text-ink">Programs</h2>
        <p className="text-sm text-ink-soft">
          The funded program, its window, and the ceilings a course price may not cross. Classes are checked
          against these on the way in.
        </p>

        <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="space-y-3">
            {tenant.programs.length === 0 ? (
              <EmptyState
                title="No program yet"
                description="Add the program that funds this tenancy's classes — for FAST AI, the Workforce Investment Trust Fund program running 2027-02-01 to 2028-06-30."
              />
            ) : null}

            {tenant.programs.map((entry) => {
              const entries = tenant.classes.filter((klass) => klass.programId === entry.id);
              const spent = entries.reduce(
                (sum, klass) => sum + (klass.seats ?? 0) * (klass.pricePerSlotCents ?? 0),
                0,
              );
              return (
                <Card key={entry.id} className="p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="font-display text-base font-semibold text-ink">{entry.name}</h3>
                    <Badge tone="brand">{entry.reportingCadence ?? "no cadence set"}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-ink-faint">
                    {[entry.funder, entry.fundName].filter(Boolean).join(" · ") || "no funder recorded"}
                  </p>
                  <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="text-ink-faint">Window</dt>
                      <dd className="font-semibold text-ink">
                        {day(entry.startsOn)} → {day(entry.endsOn)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint">Award</dt>
                      <dd className="font-semibold text-ink">
                        {money(entry.awardCents)} · committed {money(spent)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint">Per instructional hour</dt>
                      <dd className="font-semibold text-ink">{money(entry.costPerHourCents)}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint">Per person per course</dt>
                      <dd className="font-semibold text-ink">{money(entry.costPerPersonCents)}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint">Contract</dt>
                      <dd className="font-semibold text-ink">
                        {day(entry.contractStartsOn)} → {day(entry.contractEndsOn)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint">Pool across providers</dt>
                      <dd className="font-semibold text-ink">{money(entry.allocationCents)}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint">Employer cap</dt>
                      <dd className="font-semibold text-ink">
                        {entry.employerSlotCap === null
                          ? "no cap"
                          : `${entry.employerSlotCap} slots per employer`}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint">Courses accepted</dt>
                      <dd className="font-semibold text-ink">
                        {entry.maxCourses === null ? "no limit" : `up to ${entry.maxCourses}`}
                      </dd>
                    </div>
                  </dl>
                  {entry.notes ? <p className="mt-3 text-xs text-ink-soft">{entry.notes}</p> : null}
                </Card>
              );
            })}
          </div>

          <Card className="h-fit">
            <h3 className="font-display text-base font-semibold text-ink">Add a program</h3>
            <form action={createProgram} className="mt-4 space-y-4">
              <input type="hidden" name="organizationId" value={tenant.id} />
              <Field label="Name" htmlFor="program-name">
                <Input id="program-name" name="name" placeholder="Focused AI Skills Training (FAST AI)" required />
              </Field>
              <Field label="Funder" htmlFor="funder">
                <Input id="funder" name="funder" placeholder="Commonwealth Corporation" />
              </Field>
              <Field label="Fund" htmlFor="fundName">
                <Input id="fundName" name="fundName" placeholder="Workforce Investment Trust Fund" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Starts" htmlFor="startsOn">
                  <Input id="startsOn" name="startsOn" type="date" />
                </Field>
                <Field label="Ends" htmlFor="endsOn">
                  <Input id="endsOn" name="endsOn" type="date" />
                </Field>
                <Field label="Award ($)" htmlFor="award">
                  <Input id="award" name="award" placeholder="400000" />
                </Field>
                <Field label="Cost / hour ($)" htmlFor="costPerHour">
                  <Input id="costPerHour" name="costPerHour" placeholder="300" />
                </Field>
                <Field label="Cost / person ($)" htmlFor="costPerPerson">
                  <Input id="costPerPerson" name="costPerPerson" placeholder="3000" />
                </Field>
                <Field label="Pool across providers ($)" htmlFor="allocation" hint="optional">
                  <Input id="allocation" name="allocation" placeholder="1615000" />
                </Field>
                <Field label="Slots / employer" htmlFor="employerSlotCap" hint="over the contract term">
                  <Input id="employerSlotCap" name="employerSlotCap" type="number" min={1} placeholder="100" />
                </Field>
                <Field label="Max courses" htmlFor="maxCourses" hint="accepted this round">
                  <Input id="maxCourses" name="maxCourses" type="number" min={1} placeholder="20" />
                </Field>
                <Field label="Contract starts" htmlFor="contractStartsOn">
                  <Input id="contractStartsOn" name="contractStartsOn" type="date" />
                </Field>
                <Field label="Contract ends" htmlFor="contractEndsOn">
                  <Input id="contractEndsOn" name="contractEndsOn" type="date" />
                </Field>
                <Field label="Reporting" htmlFor="reportingCadence">
                  <Input id="reportingCadence" name="reportingCadence" placeholder="monthly" />
                </Field>
              </div>
              <Field label="Notes" htmlFor="notes" hint="optional">
                <Textarea id="notes" name="notes" rows={2} />
              </Field>
              <Button type="submit" className="w-full">
                Add program
              </Button>
            </form>
          </Card>
        </div>
      </section>

      {/* ------------------------------------------------------------------- catalogue */}
      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold text-ink">Course catalogue</h2>
        <p className="text-sm text-ink-soft">
          What the funder&apos;s training directory can list. A course price is checked against the program&apos;s
          per-hour and per-person ceilings, whichever binds first.
        </p>

        {/* The directory: what an employer browsing it would find, and what is missing from it. */}
        <Card className="mt-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-base font-semibold text-ink">Funder&apos;s directory</h3>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="teal">{publishedCount} listed</Badge>
              <Badge tone="neutral">{listings.filter((entry) => entry.state === "draft").length} draft</Badge>
              {listings.some((entry) => entry.state === "suspended") ? (
                <Badge tone="danger">{listings.filter((entry) => entry.state === "suspended").length} suspended</Badge>
              ) : null}
            </div>
          </div>
          <p className="mt-1 text-xs text-ink-faint">
            Awarded courses are not published on the basis of the RFQ response alone; CommCorp reviews the
            submitted details, and each course&apos;s state is set on its card below. The export carries the
            course details and the provider&apos;s contact information.
          </p>
          <p className="mt-3 text-xs text-ink-soft">
            <span className="font-semibold text-ink">Directory contact</span>{" "}
            {contact.contactName || contact.contactEmail || contact.contactPhone
              ? [contact.contactName, contact.contactEmail, contact.contactPhone].filter(Boolean).join(" · ")
              : "not recorded"}
          </p>
          {contactProblems.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {contactProblems.map((problem) => (
                <li key={problem.field} className="text-xs font-semibold text-pink">
                  {problem.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>

        <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="space-y-3">
            {tenant.courses.length === 0 ? (
              <EmptyState
                title="No courses yet"
                description="Add the first course — what it teaches, how many instructional hours it runs, and what one training slot costs."
              />
            ) : null}

            {listings.map((entry) => (
              <CourseCard
                key={entry.course.id}
                course={entry.course}
                program={program}
                state={entry.state}
                listingProblems={entry.problems}
                provider={tenant.name}
                tenantSlug={tenant.slug}
                classroom={classroom}
                classroomHome={classroomHome}
                specHref={`/admin/tenants/${tenant.id}/classroom-spec?courseId=${entry.course.id}`}
              />
            ))}
          </div>

          <Card className="h-fit">
            <h3 className="font-display text-base font-semibold text-ink">Add a course</h3>
            <form action={createCourse} className="mt-4 space-y-4">
              <input type="hidden" name="organizationId" value={tenant.id} />
              {program ? <input type="hidden" name="programId" value={program.id} /> : null}
              <Field label="Title" htmlFor="course-title">
                <Input id="course-title" name="title" placeholder="Applied AI for the Frontline Role" required />
              </Field>
              <Field label="Summary" htmlFor="course-summary" hint="250 words at most">
                <Textarea id="course-summary" name="summary" rows={2} required />
              </Field>
              <Field
                label="Topic areas"
                htmlFor="course-topicAreas"
                hint="one per line, from the RFQ's in-scope list"
              >
                <Textarea id="course-topicAreas" name="topicAreas" rows={2} required />
              </Field>
              {/* §3.3's remaining submission details. The funder asks for each of these for
                  every course it is asked to consider, so the form asks before the course
                  lands in the catalogue rather than after the application is refused. */}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Course number" htmlFor="courseNumber" hint="1–20, as submitted">
                  <Input id="courseNumber" name="courseNumber" type="number" min={1} max={20} required />
                </Field>
                <Field label="Slots / offering" htmlFor="maxSlotsPerOffering" hint="most one offering takes">
                  <Input id="maxSlotsPerOffering" name="maxSlotsPerOffering" type="number" min={1} placeholder="16" required />
                </Field>
              </div>
              <Field label="AI tools covered" htmlFor="course-aiTools" hint="one per line">
                <Textarea id="course-aiTools" name="aiTools" rows={2} required />
              </Field>
              <Field label="Target occupations" htmlFor="course-targetOccupations" hint="one per line">
                <Textarea id="course-targetOccupations" name="targetOccupations" rows={2} required />
              </Field>
              <Field label="Target industries" htmlFor="course-targetIndustries" hint="one per line">
                <Textarea id="course-targetIndustries" name="targetIndustries" rows={2} required />
              </Field>
              <Field label="Workplace tasks addressed" htmlFor="course-workplaceTasks" hint="one per line">
                <Textarea id="course-workplaceTasks" name="workplaceTasks" rows={2} required />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Languages" htmlFor="course-languages" hint="other than English">
                  <Input id="course-languages" name="languages" />
                </Field>
                <Field label="Credentials" htmlFor="course-credentials" hint="if any">
                  <Input id="course-credentials" name="credentials" />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Instructional hours" htmlFor="instructionalHours">
                  <Input id="instructionalHours" name="instructionalHours" type="number" min={1} placeholder="6" required />
                </Field>
                <Field
                  label="Price / slot ($)"
                  htmlFor="pricePerSlot"
                  hint={
                    program
                      ? `max ${money(slotCeilingCents(program, 6))} at 6 hours`
                      : undefined
                  }
                >
                  <Input id="pricePerSlot" name="pricePerSlot" placeholder="1800" required />
                </Field>
              </div>
              <Field label="Who it is for" htmlFor="audience" hint="optional">
                <Input id="audience" name="audience" placeholder="Frontline staff using AI at work" />
              </Field>
              <Field label="Prerequisites" htmlFor="prerequisites" hint="optional">
                <Input id="prerequisites" name="prerequisites" placeholder="None" />
              </Field>
              {/* No "accepted into the directory" switch here: a course is created as a draft
                  and its listing state is recorded on its card, where CommCorp's review and any
                  later suspension live (§4.3, §4.4). */}
              <Button type="submit" className="w-full">
                Add course
              </Button>
            </form>
          </Card>
        </div>
      </section>

      {/* -------------------------------------------------------------------- classes */}
      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold text-ink">Classes</h2>
        <p className="text-sm text-ink-soft">
          Scheduled, priced and sponsored. Enrol a learner and the class roster, the funder&apos;s enrolment figure
          and the learner&apos;s own view all move together.
        </p>

        <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="space-y-3">
            {tenant.classes.length === 0 ? (
              <EmptyState
                title="No classes scheduled"
                description="A class takes a course, a window inside the program, seats, and a sponsor."
              />
            ) : null}

            {tenant.classes.map((klass) => (
              <ClassCard
                key={klass.id}
                klass={klass}
                provider={tenant.name}
                tenantSlug={tenant.slug}
                program={program}
                usage={
                  klass.programId && klass.sponsorOrganizationId
                    ? (usageByEmployer.get(`${klass.programId}:${klass.sponsorOrganizationId}`) ?? null)
                    : null
                }
                classroom={classroom}
                classroomHome={classroomHome}
                specHref={
                  klass.courseId
                    ? `/admin/tenants/${tenant.id}/classroom-spec?courseId=${klass.courseId}&cohortId=${klass.id}`
                    : null
                }
              />
            ))}
          </div>

          <Card className="h-fit">
            <h3 className="font-display text-base font-semibold text-ink">Schedule a class</h3>
            <form action={scheduleClass} className="mt-4 space-y-4">
              <input type="hidden" name="organizationId" value={tenant.id} />
              <Field label="Class name" htmlFor="class-name">
                <Input id="class-name" name="name" placeholder="FAST AI —Spring cohort 1" required />
              </Field>
              <Field label="Course" htmlFor="class-course">
                <Select id="class-course" name="courseId" required>
                  <option value="">Choose a course…</option>
                  {tenant.courses.map((course) => (
                    <option key={course.id} value={course.id}>
                      {course.title} · {course.instructionalHours}h · {money(course.pricePerSlotCents)}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Starts" htmlFor="class-starts">
                  <Input id="class-starts" name="startsOn" type="date" required />
                </Field>
                <Field label="Ends" htmlFor="class-ends">
                  <Input id="class-ends" name="endsOn" type="date" required />
                </Field>
                <Field label="Seats" htmlFor="class-seats">
                  <Input id="class-seats" name="seats" type="number" min={1} placeholder="16" required />
                </Field>
                <Field label="Price / slot ($)" htmlFor="class-price" hint="optional">
                  <Input id="class-price" name="pricePerSlot" placeholder="course price" />
                </Field>
              </div>
              <Field label="Delivery" htmlFor="class-delivery">
                <Select id="class-delivery" name="deliveryMode" defaultValue="instructor-led">
                  <option value="instructor-led">Instructor-led</option>
                  <option value="self-paced">Self-paced</option>
                  <option value="blended">Blended</option>
                </Select>
              </Field>
              <Field label="Sponsor" htmlFor="class-sponsor" hint="who pays for the seats">
                <Select id="class-sponsor" name="sponsorOrganizationId" defaultValue="">
                  <option value="">— none —</option>
                  {sponsors.map((sponsor) => (
                    <option key={sponsor.id} value={sponsor.id}>
                      {sponsor.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Location" htmlFor="class-location" hint="optional">
                <Input id="class-location" name="location" placeholder="Roxbury, MA" />
              </Field>
              <Button type="submit" className="w-full">
                Schedule
              </Button>
            </form>
          </Card>
        </div>
      </section>

      <p className="mt-8 text-xs text-ink-faint">
        {tenant.users.length} accounts belong to this tenancy.{" "}
        <Link href="/admin/users" className="font-semibold text-brand">
          Manage people
        </Link>
      </p>
    </div>
  );
}

/**
 * The spec input for a course, from the course, the tenancy and — for a class — the employer.
 *
 * One function for both cards on purpose: a provider who downloads the spec from a class page
 * and from its course's page must get the *same* document, or one course would have been
 * specified into two different classrooms.
 */
function classroomSpecInput(input: {
  provider: string;
  tenantSlug: string;
  sponsorName: string | null;
  startsOn: Date;
  course: TenantCourse;
}): ClassroomSpecInput {
  return {
    organizationSlug: input.tenantSlug,
    providerName: input.provider,
    sponsorName: input.sponsorName,
    startsOn: input.startsOn,
    course: {
      title: input.course.title,
      summary: input.course.summary,
      audience: input.course.audience,
      prerequisites: input.course.prerequisites,
      instructionalHours: input.course.instructionalHours,
      deliveryMode: input.course.deliveryMode,
    },
    modules: input.course.modules.map((module) => ({
      position: module.position,
      title: module.title,
      hours: module.hours,
      objectives: module.objectives,
      activity: module.activity,
      outcome: module.outcome,
    })),
  };
}

/**
 * One catalogue entry: its price against the program's ceilings, its authored modules, and the
 * AI classroom it is taught with.
 */
function CourseCard({
  course,
  program,
  state,
  listingProblems: problems,
  provider,
  tenantSlug,
  classroom,
  classroomHome,
  specHref,
}: {
  course: TenantCourse;
  program: Tenant["programs"][number] | null;
  /** Where the course stands with the funder's directory (§4.3, §4.4). */
  state: ReturnType<typeof directoryState>;
  /** What is standing between it and a usable listing: the draft, the suspension, the topics. */
  listingProblems: RuleProblem[];
  provider: string;
  tenantSlug: string;
  classroom: ClassroomConfig;
  classroomHome: string | null;
  specHref: string;
}) {
  const ceiling = program
    ? slotCeilingCents(program, course.instructionalHours)
    : null;
  const overCeiling = ceiling !== null && course.pricePerSlotCents > ceiling;
  const authored = course.modules.reduce((sum, module) => sum + module.hours, 0);
  const topics = (course.topicAreas ?? "").split("\n").filter((line) => line.trim() !== "");
  // Named rather than refused: the RFQ considers other AI-related topics as needed, so an
  // unlisted one is a question for CommCorp, not a rule this page may invent.
  const outside = unrecognisedTopics(topics);
  // The §3.3 details, one per line as they were typed.
  const listed = (value: string | null) => (value ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const tools = listed(course.aiTools);
  const occupations = listed(course.targetOccupations);
  const industries = listed(course.targetIndustries);
  const tasks = listed(course.workplaceTasks);
  // A course the funder has been asked to consider has to be able to answer §3.3's questions;
  // one that cannot is shown as incomplete rather than quietly listed.
  const incomplete =
    course.courseNumber === null ||
    tools.length === 0 ||
    occupations.length === 0 ||
    industries.length === 0 ||
    tasks.length === 0 ||
    course.maxSlotsPerOffering === null;
  const effective = effectiveClassroom(course);
  const classroomIssues = classroomProblems(
    {
      course: {
        title: course.title,
        classroomUrl: course.classroomUrl,
        moduleCount: course.modules.length,
      },
    },
    classroom,
  );
  const spec = classroomSpecJson(
    classroomSpecInput({ provider, tenantSlug, sponsorName: null, startsOn: course.createdAt, course }),
  );

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-base font-semibold text-ink">{course.title}</h3>
            <Badge tone="neutral">{course.deliveryMode}</Badge>
            {state === "published" ? <Badge tone="teal">in the directory</Badge> : null}
            {state === "draft" ? <Badge tone="amber">not yet accepted</Badge> : null}
            {state === "suspended" ? <Badge tone="danger">listing suspended</Badge> : null}
            {overCeiling ? <Badge tone="danger">over the ceiling</Badge> : null}
            {topics.length === 0 ? <Badge tone="danger">no topic area</Badge> : null}
            {outside.length > 0 ? <Badge tone="amber">topic not on the list</Badge> : null}
            {incomplete ? <Badge tone="danger">§3.3 details missing</Badge> : null}
          </div>
          {course.summary ? <p className="mt-1 text-sm text-ink-soft">{course.summary}</p> : null}
          <p className="mt-1 text-xs text-ink-faint">
            {[
              `${course.instructionalHours} instructional hours`,
              `${money(course.pricePerSlotCents)} per slot`,
              ceiling !== null ? `ceiling ${money(ceiling)}` : null,
              `${course.modules.length} modules`,
              authored > 0 ? `${authored}h authored` : "nothing authored yet",
              topics.length > 0 ? topics.join(", ") : null,
              course.audience,
              course.prerequisites ? `prerequisites: ${course.prerequisites}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>

          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-ink-faint">Course number</dt>
              <dd className="font-semibold text-ink">{course.courseNumber ?? "not numbered"}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Slots per offering</dt>
              <dd className="font-semibold text-ink">{course.maxSlotsPerOffering ?? "not stated"}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Languages</dt>
              <dd className="font-semibold text-ink">{course.languages ?? "English"}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">AI tools covered</dt>
              <dd className="font-semibold text-ink">{tools.length > 0 ? tools.join(", ") : "none stated"}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Target occupations</dt>
              <dd className="font-semibold text-ink">
                {occupations.length > 0 ? occupations.join(", ") : "none stated"}
              </dd>
            </div>
            <div>
              <dt className="text-ink-faint">Target industries</dt>
              <dd className="font-semibold text-ink">{industries.length > 0 ? industries.join(", ") : "none stated"}</dd>
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <dt className="text-ink-faint">Workplace tasks addressed</dt>
              <dd className="font-semibold text-ink">{tasks.length > 0 ? tasks.join("; ") : "none stated"}</dd>
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <dt className="text-ink-faint">Credentials earned</dt>
              <dd className="font-semibold text-ink">{course.credentials ?? "none"}</dd>
            </div>
          </dl>
        </div>
      </div>

      {course.modules.length > 0 ? (
        <ol className="mt-4 space-y-3 border-t border-line pt-3">
          {course.modules.map((module) => (
            <li key={module.id} className="text-sm">
              <p className="font-semibold text-ink">
                {module.position}. {module.title}{" "}
                <span className="text-xs font-normal text-ink-faint">{module.hours}h</span>
              </p>
              <ul className="mt-1 ml-4 list-disc space-y-0.5 text-xs text-ink-soft">
                {module.objectives
                  .split("\n")
                  .filter((line) => line.trim() !== "")
                  .map((line, index) => (
                    <li key={index}>{line.replace(/^[-•*]\s*/, "")}</li>
                  ))}
              </ul>
              {module.activity ? <p className="mt-1 text-xs text-ink-faint">Activity: {module.activity}</p> : null}
              {module.outcome ? <p className="text-xs text-ink-faint">Assessed by: {module.outcome}</p> : null}
            </li>
          ))}
        </ol>
      ) : null}

      <ClassroomPanel
        target="course"
        id={course.id}
        stored={course.classroomUrl}
        effective={effective}
        problems={classroomIssues}
        config={classroom}
        home={classroomHome}
        spec={spec}
        specHref={specHref}
        specName={classroomSpecFilename(course.title)}
      />

      {/* The listing, and where it stands: the provider records CommCorp's decision here rather
          than in a note somewhere else, and a suspension's reason travels with it. */}
      <div className="mt-4 border-t border-line pt-3">
        {problems.length > 0 ? (
          <ul className="mb-3 space-y-1">
            {problems.map((problem) => (
              <li key={problem.field} className="text-xs font-semibold text-pink">
                {problem.message}
              </li>
            ))}
          </ul>
        ) : null}
        {course.directoryApprovedAt ? (
          <p className="mb-3 text-xs text-ink-faint">
            Accepted into the directory {day(course.directoryApprovedAt)}
            {course.listingSuspendedAt ? ` · suspended ${day(course.listingSuspendedAt)}` : ""}
            {course.listingNote ? ` · ${course.listingNote}` : ""}
          </p>
        ) : null}
        <form action={setListingState} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="courseId" value={course.id} />
          <label className="text-[11px] font-semibold text-ink-soft">
            <span className="mb-1 block">Listing</span>
            <Select name="state" defaultValue={state} className="py-1.5 text-xs">
              <option value="draft">Draft — not in the directory</option>
              <option value="published">In the directory</option>
              <option value="suspended">Suspended by the funder</option>
            </Select>
          </label>
          <label className="text-[11px] font-semibold text-ink-soft">
            <span className="mb-1 block">Note</span>
            <Input name="note" defaultValue={course.listingNote ?? ""} className="w-56 py-1.5 text-xs" />
          </label>
          <Button type="submit" variant="secondary" size="sm">
            Save
          </Button>
        </form>
      </div>

      <details className="mt-4 border-t border-line pt-3">
        <summary className="cursor-pointer text-xs font-semibold text-brand">Add a module</summary>
        <form action={addCourseModule} className="mt-3 space-y-3">
          <input type="hidden" name="courseId" value={course.id} />
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem]">
            <Field label="Module title" htmlFor={`module-title-${course.id}`}>
              <Input id={`module-title-${course.id}`} name="title" required />
            </Field>
            <Field label="Hours" htmlFor={`module-hours-${course.id}`}>
              <Input id={`module-hours-${course.id}`} name="hours" type="number" min={0.5} step={0.5} defaultValue={1.5} />
            </Field>
          </div>
          <Field label="Objectives" htmlFor={`module-objectives-${course.id}`} hint="one per line">
            <Textarea id={`module-objectives-${course.id}`} name="objectives" rows={3} required />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Activity" htmlFor={`module-activity-${course.id}`} hint="optional">
              <Input id={`module-activity-${course.id}`} name="activity" />
            </Field>
            <Field label="Assessed by" htmlFor={`module-outcome-${course.id}`} hint="optional">
              <Input id={`module-outcome-${course.id}`} name="outcome" />
            </Field>
          </div>
          <Button type="submit" variant="secondary" size="sm">
            Add module
          </Button>
        </form>
      </details>
    </Card>
  );
}

/**
 * One class: its schedule and price, its AI classroom, then the roster with attendance and
 * completion.
 */
function ClassCard({
  klass,
  provider,
  tenantSlug,
  program,
  usage,
  classroom,
  classroomHome,
  specHref,
}: {
  klass: TenantClass;
  provider: string;
  tenantSlug: string;
  program: Tenant["programs"][number] | null;
  /** This employer's position against the program's cap, or null when there is no cap to be at. */
  usage: EmployerSlotUsage | null;
  classroom: ClassroomConfig;
  classroomHome: string | null;
  specHref: string | null;
}) {
  const course = klass.course;
  const enrolledCount = klass.enrollments.length;
  const overSeats = klass.seats !== null && enrolledCount > klass.seats;
  const value = (klass.seats ?? 0) * (klass.pricePerSlotCents ?? 0);
  const completedCount = klass.enrollments.filter((entry) => entry.status === "COMPLETED").length;
  // Judged against the day the class starts, not today: a memo that expires the week before the
  // first session is not current for the slot being delivered in it.
  const sponsorProblems = klass.sponsor
    ? eligibilityProblems(
        {
          name: klass.sponsor.name,
          preRegistered: klass.sponsor.isPreRegistered,
          fein: klass.sponsor.fein,
          memoExpiresOn: klass.sponsor.eligibilityMemoExpiresOn,
        },
        klass.startsOn ?? new Date(),
      )
    : [];
  const effective = effectiveClassroom(
    { classroomUrl: course?.classroomUrl ?? null },
    { classroomUrl: klass.classroomUrl },
  );
  const problems = classroomProblems(
    {
      course: {
        title: course?.title ?? "this class",
        classroomUrl: course?.classroomUrl ?? null,
        moduleCount: course?.modules.length ?? 0,
      },
      cohort: { name: klass.name, classroomUrl: klass.classroomUrl },
    },
    classroom,
  );
  const surveyLinks = feedbackLinks(klass);
  const surveyGaps = feedbackGaps(klass);
  const spec =
    course && specHref
      ? classroomSpecJson(
          classroomSpecInput({
            provider,
            tenantSlug,
            sponsorName: klass.sponsor?.name ?? null,
            // A class's classroom is generated for *this sitting*, so its run comes from the
            // date the class starts; the program's window and the course's own record are the
            // fallbacks for a class scheduled before either existed.
            startsOn: klass.startsOn ?? program?.startsOn ?? course.createdAt,
            course,
          }),
        )
      : "";

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-base font-semibold text-ink">{klass.name}</h3>
            <Badge tone="neutral">
              <span className="font-mono">{klass.joinCode}</span>
            </Badge>
            {overSeats ? <Badge tone="danger">over seats</Badge> : null}
            {klass.programId && !klass.sponsor ? <Badge tone="danger">no sponsor</Badge> : null}
            {sponsorProblems.length > 0 ? <Badge tone="danger">sponsor not eligible</Badge> : null}
            {usage && usage.unreimbursedCompletions > 0 ? (
              <Badge tone="danger">past the employer cap</Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-ink-faint">
            {[
              klass.course?.title ?? "no course",
              `${day(klass.startsOn)} → ${day(klass.endsOn)}`,
              klass.seats !== null ? `${enrolledCount}/${klass.seats} seats` : `${enrolledCount} enrolled`,
              klass.instructionalHours !== null ? `${klass.instructionalHours}h` : null,
              klass.pricePerSlotCents !== null ? `${money(klass.pricePerSlotCents)} per slot` : null,
              klass.pricePerSlotCents !== null ? `${money(value)} committed` : null,
              klass.deliveryMode,
              klass.location,
              `sponsored by ${klass.sponsor?.name ?? "nobody"}`,
              `${completedCount} completed`,
              klass.pricePerSlotCents !== null
                ? `${money(completedCount * klass.pricePerSlotCents)} reimbursable`
                : null,
              usage && usage.cap !== null
                ? `${usage.slotsUsed}/${usage.cap} employer slots used`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {sponsorProblems.length > 0 ? (
            <p className="mt-2 text-xs font-semibold text-pink">{sponsorProblems[0].message}</p>
          ) : null}
          {usage && usage.unreimbursedCompletions > 0 ? (
            <p className="mt-2 text-xs font-semibold text-pink">
              {usage.unreimbursedCompletions} completion
              {usage.unreimbursedCompletions === 1 ? "" : "s"} past “{klass.sponsor?.name}”&apos;s {" "}
              {usage.cap}-slot cap, which the funder will not pay for.
            </p>
          ) : null}
        </div>
      </div>

      <ClassroomPanel
        target="class"
        id={klass.id}
        stored={klass.classroomUrl}
        effective={effective}
        problems={problems}
        config={classroom}
        home={classroomHome}
        spec={spec}
        specHref={specHref}
        specName={course ? classroomSpecFilename(course.title) : ""}
      />

      {/* The funder's feedback instruments for this sitting (§4.5). Nothing here blocks the
          class: the instruments and their timing are set at contracting, so a class that has
          not been given them yet is told so rather than refused. */}
      <div className="mt-4 border-t border-line pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-ink">Funder feedback</h4>
          <div className="flex flex-wrap items-center gap-2">
            {surveyLinks.trainee ? (
              <a
                href={surveyLinks.trainee}
                className="text-xs font-semibold text-brand hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                Trainee survey
              </a>
            ) : null}
            {surveyLinks.employer ? (
              <a
                href={surveyLinks.employer}
                className="text-xs font-semibold text-brand hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                Employer survey
              </a>
            ) : null}
          </div>
        </div>
        <p className={`mt-1 text-xs ${surveyGaps.length > 0 ? "font-semibold text-amber" : "text-ink-faint"}`}>
          {feedbackSummary(klass)}
        </p>
        <form action={setClassFeedback} className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="cohortId" value={klass.id} />
          <label className="text-[11px] font-semibold text-ink-soft">
            <span className="mb-1 block">Trainee survey</span>
            <Input
              name="traineeSurveyUrl"
              type="url"
              defaultValue={klass.traineeSurveyUrl ?? ""}
              placeholder="https://…"
              className="w-64 py-1.5 text-xs"
            />
          </label>
          <label className="text-[11px] font-semibold text-ink-soft">
            <span className="mb-1 block">Employer survey</span>
            <Input
              name="employerSurveyUrl"
              type="url"
              defaultValue={klass.employerSurveyUrl ?? ""}
              placeholder="https://…"
              className="w-64 py-1.5 text-xs"
            />
          </label>
          <Button type="submit" variant="secondary" size="sm">
            Save surveys
          </Button>
        </form>
      </div>

      <ul className="mt-4 space-y-3 border-t border-line pt-3">
        {klass.enrollments.length === 0 ? (
          <li className="text-xs text-ink-faint">Nobody enrolled yet.</li>
        ) : null}

        {klass.enrollments.map((entry) => (
          <li key={entry.id} className="rounded-xl border border-line bg-surface/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{entry.user.name}</p>
                <p className="truncate text-xs text-ink-faint">{entry.user.email}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={ENROLMENT_TONE[entry.status]}>{entry.status.toLowerCase()}</Badge>
                <span className="text-xs text-ink-faint">{entry.hoursAttended}h attended</span>
              </div>
            </div>

            {entry.attendances.length > 0 ? (
              <p className="mt-1 text-[11px] text-ink-faint">
                {entry.attendances
                  .map((sitting) => `${day(sitting.sessionDate)} ${sitting.status.toLowerCase()} ${sitting.hours}h`)
                  .join(" · ")}
              </p>
            ) : null}

            <div className="mt-2 flex flex-wrap items-end gap-2">
              <form action={recordAttendance} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="enrollmentId" value={entry.id} />
                <label className="text-[11px] font-semibold text-ink-soft">
                  <span className="mb-1 block">Sitting</span>
                  <Input name="sessionDate" type="date" className="w-[9.5rem] py-1.5 text-xs" required />
                </label>
                <label className="text-[11px] font-semibold text-ink-soft">
                  <span className="mb-1 block">Hours</span>
                  <Input name="hours" type="number" min={0} step={0.5} defaultValue={1.5} className="w-20 py-1.5 text-xs" />
                </label>
                <label className="text-[11px] font-semibold text-ink-soft">
                  <span className="mb-1 block">Status</span>
                  <Select name="status" defaultValue="PRESENT" className="py-1.5 text-xs">
                    <option value="PRESENT">Present</option>
                    <option value="ABSENT">Absent</option>
                    <option value="EXCUSED">Excused</option>
                  </Select>
                </label>
                <Button type="submit" variant="secondary" size="sm">
                  Record
                </Button>
              </form>

              <form action={setEnrollmentStatus} className="flex items-center gap-2">
                <input type="hidden" name="enrollmentId" value={entry.id} />
                <Button type="submit" name="status" value="COMPLETED" variant="success" size="sm">
                  Complete
                </Button>
                <Button type="submit" name="status" value="WITHDRAWN" variant="ghost" size="sm">
                  Withdraw
                </Button>
              </form>
            </div>
          </li>
        ))}
      </ul>

      <form action={enrollLearner} className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-3">
        <input type="hidden" name="cohortId" value={klass.id} />
        <label className="text-[11px] font-semibold text-ink-soft">
          <span className="mb-1 block">Learner email</span>
          <Input name="email" type="email" className="w-60 py-1.5 text-xs" required />
        </label>
        <label className="text-[11px] font-semibold text-ink-soft">
          <span className="mb-1 block">Name</span>
          <Input name="name" className="w-44 py-1.5 text-xs" />
        </label>
        <Button type="submit" variant="secondary" size="sm">
          Enrol
        </Button>
      </form>
    </Card>
  );
}

/**
 * A course's or a class's AI classroom: the address, where it came from, what is missing, the
 * specification to build one from, and the field to attach the result in.
 *
 * One component for both rows on purpose. The two fields are the same kind of fact — an
 * address copied out of AthenIQ's classroom host — and the only differences are which row is
 * written and which address wins, both of which are arguments here rather than a second
 * implementation that would drift.
 */
function ClassroomPanel({
  target,
  id,
  stored,
  effective,
  problems,
  config,
  home,
  spec,
  specHref,
  specName,
}: {
  target: "course" | "class";
  id: string;
  stored: string | null;
  effective: EffectiveClassroom;
  problems: RuleProblem[];
  config: ClassroomConfig;
  home: string | null;
  spec: string;
  specHref: string | null;
  specName: string;
}) {
  // The specification is a *prompt for the next step*, so the panel only offers it where a
  // classroom could actually be generated from it: a course with modules, on a deployment
  // that has a host to generate it on.
  const offerSpec = spec !== "" && specHref !== null && config.enabled;

  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">AI classroom</p>
        <div className="flex flex-wrap items-center gap-2">
          {effective.url ? (
            <>
              {/* Which row answered matters to whoever maintains it: a class's own address
                  is this sitting's, while the course's is shared by every class of it. */}
              <Badge tone="teal">
                {effective.source === "class" ? "this class only" : "from the course"}
              </Badge>
              <a
                href={effective.url}
                target="_blank"
                rel="noreferrer"
                className={buttonClass("secondary", "sm")}
              >
                Open the classroom
              </a>
            </>
          ) : (
            <Badge tone="neutral">none attached</Badge>
          )}
        </div>
      </div>

      {problems.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {problems.map((problem, index) => (
            <li key={index} className="font-mono text-[11px] text-amber">
              {problem.message}
            </li>
          ))}
        </ul>
      ) : null}

      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-semibold text-brand">
          {stored ? "Change the AI classroom" : "Attach an AI classroom"}
        </summary>

        <form action={setClassroom} className="mt-3 space-y-3">
          <input type="hidden" name="target" value={target} />
          <input type="hidden" name="id" value={id} />
          <Field
            label="Classroom address"
            htmlFor={`classroom-${target}-${id}`}
            hint={target === "course" ? "shared by every class of this course" : "this sitting only"}
          >
            <Input
              id={`classroom-${target}-${id}`}
              name="classroomUrl"
              defaultValue={stored ?? ""}
              placeholder="https://classroom.example.edu/…"
            />
          </Field>
          <p className="text-[11px] text-ink-faint">
            Leave it empty to take the classroom down. http(s) only, and no username or password in the
            address.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="secondary" size="sm">
              Save classroom
            </Button>
            {home ? (
              <a
                href={home}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-semibold text-brand hover:underline"
              >
                Build one in the classroom host →
              </a>
            ) : null}
          </div>
        </form>

        {offerSpec ? (
          <>
            <p className="mt-3 text-[11px] text-ink-soft">
              The classroom specification for AthenIQ&apos;s classroom host, generated from this course&apos;s own
              modules and objectives — so the classroom cannot teach something the course does not assess.
            </p>
            <Textarea
              readOnly
              rows={12}
              value={spec}
              aria-label={`Classroom specification for ${specName}`}
              className="mt-2"
            />
            <a
              href={specHref}
              className="mt-2 inline-block text-xs font-semibold text-brand hover:underline"
            >
              Download {specName} →
            </a>
          </>
        ) : null}
      </details>
    </div>
  );
}
