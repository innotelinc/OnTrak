import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { addCohortMember, createCohort, deleteCohort, removeCohortMember, updateCohort } from "@/app/actions/instructor";
import { Flash, PageHeader } from "@/components/PageHeader";
import { Badge, Button, Card, EmptyState, Field, Input, Textarea } from "@/components/ui";
import { cn, initials, accentFor, formatRelative } from "@/lib/cn";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Classes" };

export default async function CohortsPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const { flash, error } = await searchParams;
  const user = await requireSession();
  const t = await getTranslator();

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
    },
    orderBy: { createdAt: "desc" },
  });

  const staff = await prisma.user.count({ where: { role: { in: ["ADMIN", "INSTRUCTOR"] } } });

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
                    </div>
                    {cohort.description ? <p className="mt-1.5 text-sm text-ink-soft">{cohort.description}</p> : null}
                    <p className="mt-1 text-xs text-ink-faint">
                      {t("cohorts.taughtBy", {
                        name: cohort.instructor.name,
                        when: formatRelative(cohort.createdAt),
                      })}
                    </p>
                  </div>

                  <form action={deleteCohort}>
                    <input type="hidden" name="id" value={cohort.id} />
                    <Button type="submit" variant="danger" size="sm">
                      {t("cohorts.deleteClass")}
                    </Button>
                  </form>
                </div>

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
                      <Input name="email" type="email" placeholder="student@college.edu" required />
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
                      <Input name="name" defaultValue={cohort.name} required />
                      <Textarea
                        name="description"
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
