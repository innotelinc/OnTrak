import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { evaluateScenario, loadAvailabilityContext, platformLabel } from "@/lib/availability";
import { Flash, PageHeader } from "@/components/PageHeader";
import { Badge, ButtonLink, Card, EmptyState, ProgressBar, Stat } from "@/components/ui";
import { cn, formatRelative } from "@/lib/cn";
import { getTranslator } from "@/lib/i18n-server";
import { clearedPassMark, scorePercent } from "@/lib/score-rules";

export const metadata: Metadata = { title: "Teaching overview" };

export default async function InstructorHome({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const { flash, error } = await searchParams;
  const user = await requireSession();
  const t = await getTranslator();

  const [context, scenarios, cohorts, attempts, learners] = await Promise.all([
    loadAvailabilityContext(),
    prisma.scenario.findMany({
      include: {
        software: { include: { softwarePackage: true } },
        _count: { select: { attempts: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.cohort.findMany({
      where: user.role === "ADMIN" ? {} : { instructorId: user.id },
      include: { _count: { select: { members: true, assignments: true } } },
      orderBy: { createdAt: "desc" },
      take: 6,
    }),
    prisma.attempt.findMany({
      include: {
        user: { select: { name: true, email: true } },
        scenario: { select: { title: true, platform: true, passScore: true } },
      },
      orderBy: { submittedAt: "desc" },
      take: 8,
    }),
    prisma.user.count({ where: { role: "STUDENT", active: true } }),
  ]);

  const withAvailability = scenarios.map((scenario) => ({ scenario, availability: evaluateScenario(scenario, context) }));
  const runnable = withAvailability.filter((entry) => entry.availability.available);
  const blocked = withAvailability.filter((entry) => !entry.availability.available);
  const graded = await prisma.attempt.findMany({
    where: { status: { in: ["GRADED", "SUBMITTED"] } },
    select: { score: true, maxScore: true, scenarioId: true },
  });
  const average =
    graded.length > 0
      ? Math.round(
          (graded.reduce((sum, attempt) => sum + (attempt.maxScore > 0 ? attempt.score / attempt.maxScore : 0), 0) /
            graded.length) *
            100,
        )
      : 0;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow={t("instructor.eyebrow")}
        title={t("instructor.greeting", { name: user.name.split(" ")[0] })}
        description={t("instructor.description")}
        actions={
          <>
            <ButtonLink href="/instructor/scenarios/new">{t("instructor.newScenario")}</ButtonLink>
            <ButtonLink href="/instructor/analytics" variant="secondary">
              {t("nav.analytics")}
            </ButtonLink>
            <ButtonLink href="/instructor/attempts" variant="secondary">
              {t("instructor.reviewAttempts")}
            </ButtonLink>
          </>
        }
      />
      <Flash flash={flash} error={error} />

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={t("instructor.stat.live")}
          value={runnable.length}
          hint={t("instructor.hint.blocked", { count: blocked.length })}
          tone="teal"
        />
        <Stat
          label={t("instructor.stat.students")}
          value={learners}
          hint={t("instructor.hint.activeStudents")}
          tone="brand"
        />
        <Stat label={t("instructor.stat.graded")} value={graded.length} hint={t("instructor.hint.allTime")} tone="sky" />
        <Stat
          label={t("instructor.stat.average")}
          value={`${average}%`}
          hint={t("instructor.hint.acrossGraded")}
          tone={average >= 70 ? "teal" : "amber"}
        />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section>
          <div className="flex items-end justify-between gap-4">
            <h2 className="font-display text-lg font-semibold text-ink">{t("instructor.scenarios")}</h2>
            <Link href="/instructor/scenarios" className="text-sm font-semibold text-brand hover:underline">
              {t("instructor.manageAll")} →
            </Link>
          </div>

          {withAvailability.length === 0 ? (
            <div className="mt-3">
              <EmptyState
                title={t("instructor.emptyScenarios.title")}
                description={t("instructor.emptyScenarios.description")}
                action={<ButtonLink href="/instructor/scenarios/new">{t("instructor.emptyScenarios.action")}</ButtonLink>}
              />
            </div>
          ) : (
            <ul className="mt-3 space-y-2.5">
              {withAvailability.slice(0, 6).map(({ scenario, availability }) => (
                <li key={scenario.id}>
                  <Card className="p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={scenario.platform === "LINUX" ? "amber" : scenario.platform === "WINDOWS" ? "sky" : "pink"}>
                        {platformLabel(scenario.platform)}
                      </Badge>
                      <Badge tone={scenario.published ? "teal" : "neutral"}>
                        {scenario.published ? t("instructor.badge.published") : t("instructor.badge.draft")}
                      </Badge>
                      {availability.available ? (
                        <Badge tone="teal">{t("instructor.badge.runnable")}</Badge>
                      ) : (
                        <Badge tone="danger">{t("instructor.badge.blockers", { count: availability.blockers.length })}</Badge>
                      )}
                      <span className="ml-auto text-xs text-ink-faint">
                        {t("instructor.attemptsCount", { count: scenario._count.attempts })}
                      </span>
                    </div>
                    <Link
                      href={`/instructor/scenarios/${scenario.id}`}
                      className="mt-2.5 block font-display text-base font-semibold text-ink hover:text-brand"
                    >
                      {scenario.title}
                    </Link>
                    <p className="mt-1 line-clamp-2 text-sm text-ink-soft">{scenario.summary}</p>
                    {!availability.available ? (
                      <p className="mt-2 text-xs text-pink">{availability.blockers[0]?.message}</p>
                    ) : null}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-6">
          <div>
            <div className="flex items-end justify-between gap-4">
              <h2 className="font-display text-lg font-semibold text-ink">{t("instructor.classes")}</h2>
              <Link href="/instructor/cohorts" className="text-sm font-semibold text-brand hover:underline">
                {t("instructor.manage")} →
              </Link>
            </div>
            {cohorts.length === 0 ? (
              <Card className="mt-3 p-5 text-sm text-ink-soft">{t("instructor.emptyClasses")}</Card>
            ) : (
              <ul className="mt-3 space-y-2.5">
                {cohorts.map((cohort) => (
                  <li key={cohort.id}>
                    <Card className="p-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-display text-sm font-semibold text-ink">{cohort.name}</span>
                        <Badge tone="neutral">{cohort.joinCode}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-ink-faint">
                        {t("instructor.cohortCounts", {
                          students: cohort._count.members,
                          assignments: cohort._count.assignments,
                        })}
                      </p>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <div className="flex items-end justify-between gap-4">
              <h2 className="font-display text-lg font-semibold text-ink">{t("instructor.latestSubmissions")}</h2>
              <Link href="/instructor/attempts" className="text-sm font-semibold text-brand hover:underline">
                {t("instructor.all")} →
              </Link>
            </div>
            {attempts.length === 0 ? (
              <Card className="mt-3 p-5 text-sm text-ink-soft">{t("instructor.nothingSubmitted")}</Card>
            ) : (
              <Card className="mt-3 overflow-hidden p-0">
                <ul className="divide-y divide-line">
                  {attempts.map((attempt) => {
                    const percent = scorePercent(attempt.score, attempt.maxScore);
                    const passed = clearedPassMark({
                      score: attempt.score,
                      maxScore: attempt.maxScore,
                      passScore: attempt.scenario.passScore,
                    });
                    return (
                      <li key={attempt.id}>
                        <Link
                          href={`/instructor/attempts/${attempt.id}`}
                          className="block px-4 py-3 transition hover:bg-surface-muted/60"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="truncate text-sm font-medium text-ink">{attempt.user.name}</span>
                            <span className={cn("font-mono text-xs font-semibold", passed ? "text-teal" : "text-amber")}>
                              {percent}%
                            </span>
                          </div>
                          <p className="mt-0.5 truncate text-xs text-ink-faint">
                            {attempt.scenario.title} · {formatRelative(attempt.submittedAt ?? attempt.startedAt)}
                          </p>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}
          </div>

          {average > 0 ? (
            <Card className="p-5">
              <h3 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">
                {t("instructor.cohortHealth")}
              </h3>
              <p className="mt-1 text-xs text-ink-faint">{t("instructor.cohortHealthHint")}</p>
              <ProgressBar value={average} tone={average >= 70 ? "teal" : "amber"} className="mt-3" />
              <p className="mt-2 text-sm text-ink-soft">
                {average >= 85
                  ? t("instructor.cohortHealth.strong")
                  : average >= 70
                    ? t("instructor.cohortHealth.onTrack")
                    : t("instructor.cohortHealth.low")}
              </p>
            </Card>
          ) : null}
        </section>
      </div>
    </div>
  );
}
