import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { addCohortMember, createCohort, deleteCohort, removeCohortMember, updateCohort } from "@/app/actions/instructor";
import { setClassFeedback, setClassroom } from "@/app/actions/tenants";
import {
  classroomConfigFromEnv,
  classroomHomeUrl,
  classroomProblems,
  effectiveClassroom,
  type ClassroomConfig,
} from "@/lib/classroom-rules";
import { feedbackGaps, feedbackLinks, feedbackSummary } from "@/lib/feedback-rules";
import { Flash, PageHeader } from "@/components/PageHeader";
import { Badge, Button, Card, EmptyState, Field, Input, Textarea, buttonClass } from "@/components/ui";
import { cn, initials, accentFor, formatRelative } from "@/lib/cn";
import { getTranslator, type Translator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Classes" };

export default async function CohortsPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const { flash, error } = await searchParams;
  const user = await requireSession();
  const t = await getTranslator();
  const classroom = classroomConfigFromEnv();
  const classroomHome = classroomHomeUrl(classroom);

  const cohorts = await prisma.cohort.findMany({
    where: user.role === "ADMIN" ? {} : { instructorId: user.id },
    include: {
      instructor: { select: { name: true } },
      members: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              accent: true,
              _count: { select: { attempts: true } },
            },
          },
        },
        orderBy: { joinedAt: "asc" },
      },
      assignments: { select: { id: true } },
      // The course a class teaches, because that is where its AI classroom comes from: the
      // course's is shared by every class of it, and this one's own is an override.
      course: { select: { title: true, classroomUrl: true, modules: { select: { id: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  const staff = await prisma.user.count({ where: { role: { in: ["ADMIN", "INSTRUCTOR"] } } });

  // One grouped count rather than a query per class: the export button needs to
  // know whether a class actually holds certificates to export.
  const certificatesPerCohort = new Map<string, number>();
  if (cohorts.length > 0) {
    const grouped = await prisma.attempt.groupBy({
      by: ["userId"],
      where: { certificateIssuedAt: { not: null }, certificateRevokedAt: null },
      _count: { _all: true },
    });
    const heldByUser = new Map(grouped.map((row) => [row.userId, row._count._all]));
    for (const cohort of cohorts) {
      certificatesPerCohort.set(
        cohort.id,
        cohort.members.reduce((total, member) => total + (heldByUser.get(member.user.id) ?? 0), 0),
      );
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow={t("cohorts.eyebrow")}
        title={t("cohorts.title")}
        description={t("cohorts.description")}
      />
      <Flash flash={flash} error={error} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          {cohorts.length === 0 ? (
            <EmptyState title={t("cohorts.empty.title")} description={t("cohorts.empty.description")} />
          ) : (
            cohorts.map((cohort) => (
              <Card key={cohort.id}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-display text-lg font-semibold text-ink">{cohort.name}</h2>
                      <Badge tone="brand">
                        {t("cohorts.joinCode")} <span className="ml-1 font-mono">{cohort.joinCode}</span>
                      </Badge>
                      <Badge tone="neutral">{t("cohorts.members", { count: cohort.members.length })}</Badge>
                      <Badge tone="neutral">{t("cohorts.assignments", { count: cohort.assignments.length })}</Badge>
                      <Badge tone={(certificatesPerCohort.get(cohort.id) ?? 0) > 0 ? "teal" : "neutral"}>
                        {t("cohorts.certificates", { count: certificatesPerCohort.get(cohort.id) ?? 0 })}
                      </Badge>
                    </div>
                    {cohort.description ? <p className="mt-1.5 text-sm text-ink-soft">{cohort.description}</p> : null}
                    <p className="mt-1 text-xs text-ink-faint">
                      {t("cohorts.taughtBy", {
                        name: cohort.instructor.name,
                        when: formatRelative(cohort.createdAt),
                      })}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {/* A plain anchor: this is a file download, not a route the
                        client router should intercept (or prefetch). */}
                    {(certificatesPerCohort.get(cohort.id) ?? 0) > 0 ? (
                      <a
                        href={`/instructor/cohorts/${cohort.id}/packet`}
                        className={buttonClass("secondary", "sm")}
                        title={t("cohorts.packetHint")}
                      >
                        {t("cohorts.packet")}
                      </a>
                    ) : (
                      <span className="text-xs text-ink-faint">{t("cohorts.packet.none")}</span>
                    )}
                    <form action={deleteCohort}>
                      <input type="hidden" name="id" value={cohort.id} />
                      <Button type="submit" variant="danger" size="sm">
                        {t("cohorts.deleteClass")}
                      </Button>
                    </form>
                  </div>
                </div>

                {/* AI classroom: the door this class is taught through. An instructor is who
                    builds the classroom, so this is where the address is written — the
                    permission for it is in `setClassroom`, not here. */}
                <ClassroomRow cohort={cohort} classroom={classroom} classroomHome={classroomHome} t={t} />
                <FeedbackRow cohort={cohort} t={t} />

                {/* Roster */}
                <div className="mt-5">
                  <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">{t("cohorts.roster")}</h3>
                  {cohort.members.length === 0 ? (
                    <p className="mt-2 rounded-xl2 border border-dashed border-line px-4 py-4 text-sm text-ink-faint">
                      {t("cohorts.nobody", { code: cohort.joinCode })}
                    </p>
                  ) : (
                    <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                      {cohort.members.map((member) => {
                        const accent = accentFor(member.user.accent);
                        return (
                          <li
                            key={member.id}
                            className="flex items-center gap-3 rounded-xl2 border border-line bg-surface px-3 py-2.5"
                          >
                            <span
                              className={cn(
                                "flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                                accent.bg,
                                accent.text,
                              )}
                            >
                              {initials(member.user.name)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-ink">{member.user.name}</span>
                              <span className="block truncate text-[11px] text-ink-faint">{member.user.email}</span>
                            </span>
                            {member.isMentor ? <Badge tone="lime">{t("cohorts.mentor")}</Badge> : null}
                            <form action={removeCohortMember}>
                              <input type="hidden" name="cohortId" value={cohort.id} />
                              <input type="hidden" name="userId" value={member.user.id} />
                              <button
                                type="submit"
                                className="rounded-full p-1.5 text-ink-faint transition hover:bg-pink/12 hover:text-pink"
                                aria-label={t("cohorts.remove", { name: member.user.name })}
                              >
                                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                  <path d="M6 6l12 12M18 6 6 18" />
                                </svg>
                              </button>
                            </form>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {/* Add member + rename */}
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <form action={addCohortMember} className="rounded-xl2 border border-line p-4">
                    <input type="hidden" name="cohortId" value={cohort.id} />
                    <h4 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">{t("cohorts.addStudent")}</h4>
                    <div className="mt-2 space-y-2.5">
                      {/* The heading above these controls is not associated with
                          them, so each carries its own accessible name. */}
                      <Input
                        name="email"
                        type="email"
                        aria-label={t("cohorts.addStudent")}
                        placeholder="student@college.edu"
                        required
                      />
                      <label className="flex items-center gap-2 text-xs text-ink-soft">
                        <input type="checkbox" name="isMentor" className="size-3.5 accent-[var(--brand)]" />
                        {t("cohorts.markMentor")}
                      </label>
                      <Button type="submit" size="sm" className="w-full">
                        {t("cohorts.addToRoster")}
                      </Button>
                    </div>
                  </form>

                  <form action={updateCohort} className="rounded-xl2 border border-line p-4">
                    <input type="hidden" name="id" value={cohort.id} />
                    <h4 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">{t("cohorts.rename")}</h4>
                    <div className="mt-2 space-y-2.5">
                      <Input
                        name="name"
                        aria-label={t("cohorts.className")}
                        defaultValue={cohort.name}
                        required
                      />
                      <Textarea
                        name="description"
                        aria-label={t("cohorts.descriptionLabel")}
                        defaultValue={cohort.description ?? ""}
                        className="min-h-16"
                        placeholder={t("cohorts.descriptionPlaceholder")}
                      />
                      <Button type="submit" variant="secondary" size="sm" className="w-full">
                        {t("cohorts.save")}
                      </Button>
                    </div>
                  </form>
                </div>
              </Card>
            ))
          )}
        </div>

        {/* New class */}
        <Card className="h-fit lg:sticky lg:top-24">
          <h2 className="font-display text-base font-semibold text-ink">{t("cohorts.newClass")}</h2>
          <p className="mt-1 text-xs text-ink-soft">{t("cohorts.newClassHint", { count: staff })}</p>
          <form action={createCohort} className="mt-4 space-y-3.5">
            <Field label={t("cohorts.className")} htmlFor="name">
              <Input id="name" name="name" placeholder={t("cohorts.classNamePlaceholder")} required />
            </Field>
            <Field label={t("cohorts.descriptionLabel")} htmlFor="description" hint={t("cohorts.optional")}>
              <Textarea
                id="description"
                name="description"
                className="min-h-20"
                placeholder={t("cohorts.lessonPlaceholder")}
              />
            </Field>
            <Button type="submit" className="w-full">
              {t("cohorts.createClass")}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

/**
 * The funder's two feedback instruments for one class, on the instructor's own page (§4.5).
 *
 * The person in the room is the one who can hand a trainee survey round, so this is where both
 * addresses are written — and an empty one is how a survey is taken back down. Nothing is
 * refused for being unset: the instruments and their timing are set at contracting, so a class
 * that has not been given them says so instead.
 */
function FeedbackRow({
  cohort,
  t,
}: {
  cohort: {
    id: string;
    name: string;
    organizationId: string | null;
    traineeSurveyUrl: string | null;
    employerSurveyUrl: string | null;
  };
  t: Translator;
}) {
  if (!cohort.organizationId) return null;

  const links = feedbackLinks(cohort);
  const gaps = feedbackGaps(cohort);

  return (
    <div className="mt-5 rounded-xl2 border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
          {t("cohorts.feedback.title")}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {links.trainee ? (
            <a href={links.trainee} target="_blank" rel="noreferrer" className="text-xs font-semibold text-brand hover:underline">
              {t("cohorts.feedback.trainee")}
            </a>
          ) : null}
          {links.employer ? (
            <a href={links.employer} target="_blank" rel="noreferrer" className="text-xs font-semibold text-brand hover:underline">
              {t("cohorts.feedback.employer")}
            </a>
          ) : null}
        </div>
      </div>

      {/* One line, not a list: this is a class card, and the missing survey is the one to act on. */}
      <p className={`mt-2 text-[11px] ${gaps.length > 0 ? "font-semibold text-amber" : "text-ink-faint"}`}>
        {feedbackSummary(cohort)}
      </p>

      <form action={setClassFeedback} className="mt-3 flex flex-wrap items-end gap-2">
        <input type="hidden" name="cohortId" value={cohort.id} />
        <label className="min-w-[14rem] flex-1 text-[11px] font-semibold text-ink-soft">
          <span className="mb-1 block">{t("cohorts.feedback.trainee")}</span>
          <Input
            name="traineeSurveyUrl"
            type="url"
            defaultValue={cohort.traineeSurveyUrl ?? ""}
            placeholder="https://…"
            className="py-1.5 text-xs"
          />
        </label>
        <label className="min-w-[14rem] flex-1 text-[11px] font-semibold text-ink-soft">
          <span className="mb-1 block">{t("cohorts.feedback.employer")}</span>
          <Input
            name="employerSurveyUrl"
            type="url"
            defaultValue={cohort.employerSurveyUrl ?? ""}
            placeholder="https://…"
            className="py-1.5 text-xs"
          />
        </label>
        <Button type="submit" variant="secondary" size="sm">
          {t("cohorts.feedback.save")}
        </Button>
      </form>
    </div>
  );
}

/**
 * One class's AI classroom, on the page of the person who teaches it.
 *
 * An instructor writes the *address* here and nothing else: the classroom itself is generated
 * by AthenIQ's classroom host from the specification this course produces (downloadable from
 * the tenancy's page), and what belongs in OnTrak is where a learner goes to sit in it.
 *
 * A class that belongs to no tenancy has no classroom row at all rather than a form that would
 * be refused: a class that predates tenancy is still a class, and a door nobody can attach is
 * not an affordance.
 */
function ClassroomRow({
  cohort,
  classroom,
  classroomHome,
  t,
}: {
  cohort: {
    id: string;
    name: string;
    organizationId: string | null;
    classroomUrl: string | null;
    course: { title: string; classroomUrl: string | null; modules: { id: string }[] } | null;
  };
  classroom: ClassroomConfig;
  classroomHome: string | null;
  t: Translator;
}) {
  if (!cohort.organizationId) return null;

  const effective = effectiveClassroom(
    { classroomUrl: cohort.course?.classroomUrl ?? null },
    cohort,
  );
  const problems = classroomProblems(
    {
      course: {
        title: cohort.course?.title ?? cohort.name,
        classroomUrl: cohort.course?.classroomUrl ?? null,
        moduleCount: cohort.course?.modules.length ?? 0,
      },
      cohort: { name: cohort.name, classroomUrl: cohort.classroomUrl },
    },
    classroom,
  );

  return (
    <div className="mt-5 rounded-xl2 border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
          {t("cohorts.classroom")}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {effective.url ? (
            <>
              {effective.source === "course" ? (
                <Badge tone="neutral">{t("cohorts.classroom.fromCourse")}</Badge>
              ) : null}
              <a
                href={effective.url}
                target="_blank"
                rel="noreferrer"
                className={buttonClass("secondary", "sm")}
              >
                {t("cohorts.classroom.open")}
              </a>
            </>
          ) : (
            <Badge tone="neutral">{t("cohorts.classroom.none")}</Badge>
          )}
        </div>
      </div>

      {/* One message, not a list: this is a class card, and the first reason is the one to act
          on. The tenancy's page prints them all, for whoever runs the program. */}
      {problems.length > 0 ? (
        <p className="mt-2 font-mono text-[11px] text-amber">{problems[0].message}</p>
      ) : null}

      <form action={setClassroom} className="mt-3 flex flex-wrap items-end gap-2">
        <input type="hidden" name="target" value="class" />
        <input type="hidden" name="id" value={cohort.id} />
        <label className="min-w-[18rem] flex-1 text-[11px] font-semibold text-ink-soft">
          <span className="mb-1 block">{t("cohorts.classroom.address")}</span>
          <Input
            name="classroomUrl"
            defaultValue={cohort.classroomUrl ?? ""}
            placeholder="https://classroom.example.edu/…"
            className="py-1.5 text-xs"
          />
        </label>
        <Button type="submit" variant="secondary" size="sm">
          {t("cohorts.classroom.save")}
        </Button>
        {classroomHome ? (
          <a
            href={classroomHome}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-semibold text-brand hover:underline"
          >
            {t("cohorts.classroom.build")} →
          </a>
        ) : null}
      </form>
    </div>
  );
}
