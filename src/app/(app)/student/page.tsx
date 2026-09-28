import Link from "next/link";
import type { Metadata } from "next";
import type { Platform } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { evaluateScenario, loadAvailabilityContext, platformLabel } from "@/lib/availability";
import { sweepExpiredAttempts } from "@/lib/scenarios";
import { startAttempt } from "@/app/actions/student";
import { Flash, PageHeader } from "@/components/PageHeader";
import { Badge, Button, Card, EmptyState, ProgressBar } from "@/components/ui";
import { formatDateTime, formatDuration, cn } from "@/lib/cn";
import { getTranslator, type Translator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "My scenarios" };

const PLATFORM_TONE: Record<Platform, "amber" | "sky" | "pink"> = {
  LINUX: "amber",
  WINDOWS: "sky",
  OFFICE: "pink",
};

const DIFFICULTY_TONE: Record<string, "teal" | "brand" | "amber" | "pink"> = {
  FOUNDATION: "teal",
  INTERMEDIATE: "brand",
  ADVANCED: "amber",
  EXPERT: "pink",
};

export default async function StudentHome({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const { flash, error } = await searchParams;
  const user = await requireSession();
  const t = await getTranslator();

  // Reconcile clocks first so the page never shows a stale "in progress" card.
  await sweepExpiredAttempts(user.id);

  const [context, scenarios, running, history, assignments] = await Promise.all([
    loadAvailabilityContext(),
    prisma.scenario.findMany({
      where: { published: true },
      include: { software: { include: { softwarePackage: true } } },
      orderBy: [{ platform: "asc" }, { difficulty: "asc" }, { title: "asc" }],
    }),
    prisma.attempt.findMany({
      where: { userId: user.id, status: "IN_PROGRESS" },
      include: { scenario: { select: { title: true, platform: true, summary: true, timeLimitSec: true } } },
      orderBy: { startedAt: "desc" },
    }),
    prisma.attempt.findMany({
      where: { userId: user.id, status: { in: ["GRADED", "EXPIRED", "SUBMITTED"] } },
      include: { scenario: { select: { title: true, platform: true, passScore: true } } },
      orderBy: { submittedAt: "desc" },
      take: 6,
    }),
    prisma.assignment.findMany({
      where: {
        scenario: { published: true },
        OR: [{ studentId: user.id }, { cohort: { members: { some: { userId: user.id } } } }],
      },
      include: {
        scenario: { select: { id: true, title: true, platform: true, timeLimitSec: true } },
        cohort: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // Students only see work that is actually runnable; the blocker list is for staff.
  const available = scenarios
    .map((scenario) => ({ scenario, availability: evaluateScenario(scenario, context) }))
    .filter((entry) => entry.availability.available);

  const assignedIds = new Set(assignments.map((assignment) => assignment.scenarioId));
  const assignedScenarios = available.filter((entry) => assignedIds.has(entry.scenario.id));
  const openScenarios = available.filter((entry) => !assignedIds.has(entry.scenario.id));

  // Every attempt here is finished, and the server graded the expired ones too,
  // so they count. A zero-point scenario simply has no percentage.
  const graded = history.filter((attempt) => attempt.maxScore > 0);
  // Each scenario carries its own pass mark; a hard-coded 70 would silently
  // miscount any scenario an instructor set a different bar for.
  const passed = graded.filter(
    (attempt) => (attempt.score / attempt.maxScore) * 100 >= attempt.scenario.passScore,
  );
  const average =
    graded.length > 0
      ? Math.round(graded.reduce((sum, attempt) => sum + (attempt.maxScore ? (attempt.score / attempt.maxScore) * 100 : 0), 0) / graded.length)
      : 0;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow={t("student.welcome", { name: user.name.split(" ")[0] })}
        title={t("student.title")}
        description={t("student.description")}
        actions={
          <Link href="/student/results" className="text-sm font-semibold text-brand hover:underline">
            {t("student.allResults")} →
          </Link>
        }
      />
      <Flash flash={flash} error={error} />

      {/* Stats */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
            {t("student.stat.available")}
          </p>
          <p className="mt-1 font-display text-3xl font-semibold text-ink">{available.length}</p>
          <p className="mt-1 text-xs text-ink-faint">{t("student.stat.availableHint")}</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
            {t("student.stat.average")}
          </p>
          <p className="mt-1 font-display text-3xl font-semibold text-ink">{graded.length > 0 ? `${average}%` : "—"}</p>
          <ProgressBar value={average} tone={average >= 70 ? "teal" : "amber"} className="mt-3" />
        </Card>
        <Card className="p-5">
          <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
            {t("student.stat.passed")}
          </p>
          <p className="mt-1 font-display text-3xl font-semibold text-teal">{passed.length}</p>
          <p className="mt-1 text-xs text-ink-faint">{t("student.stat.passedHint", { count: graded.length })}</p>
        </Card>
      </div>

      {/* In progress */}
      {running.length > 0 ? (
        <section className="mt-8">
          <h2 className="font-display text-lg font-semibold text-ink">{t("student.resume.title")}</h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {running.map((attempt) => {
              const left = Math.max(0, Math.floor((attempt.expiresAt.getTime() - Date.now()) / 1000));
              const total = attempt.scenario.timeLimitSec || 1;
              const used = Math.max(0, total - left);
              return (
                <li key={attempt.id}>
                  <Card className="relative overflow-hidden p-5">
                    <span className="absolute -top-8 -right-8 size-24 rounded-full gradient-brand opacity-15" aria-hidden />
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={PLATFORM_TONE[attempt.scenario.platform]}>
                        {platformLabel(attempt.scenario.platform)}
                      </Badge>
                      <Badge tone={left < 120 ? "danger" : "teal"}>
                        <span className={cn("size-1.5 animate-pulse rounded-full", left < 120 ? "bg-pink" : "bg-teal")} />
                        {t("student.resume.left", { time: formatDuration(left) })}
                      </Badge>
                    </div>
                    <h3 className="mt-3 font-display text-base font-semibold text-ink">{attempt.scenario.title}</h3>
                    <ProgressBar value={(used / total) * 100} tone={left < 120 ? "danger" : "brand"} className="mt-3" />
                    <div className="mt-4 flex items-center gap-2">
                      <Link
                        href={`/student/attempt/${attempt.id}`}
                        className="inline-flex items-center gap-1.5 rounded-full gradient-brand px-4 py-2 text-xs font-semibold text-white shadow-card"
                      >
                        {t("student.resume.resume")}
                      </Link>
                      <a href={`/student/results/${attempt.id}`} className="text-xs font-semibold text-ink-soft hover:text-brand">
                        {t("student.resume.details")}
                      </a>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* Assigned */}
      {assignedScenarios.length > 0 ? (
        <section className="mt-10">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="font-display text-lg font-semibold text-ink">{t("student.assigned.title")}</h2>
              <p className="text-sm text-ink-soft">{t("student.assigned.hint")}</p>
            </div>
          </div>
          <ul className="mt-3 grid gap-4 md:grid-cols-2">
            {assignedScenarios.map(({ scenario }) => {
              const assignment = assignments.find((item) => item.scenarioId === scenario.id);
              const overdue = assignment?.dueAt ? assignment.dueAt.getTime() < Date.now() : false;
              return (
                <li key={scenario.id}>
                  <ScenarioCard
                    scenario={scenario}
                    badge={
                      assignment?.dueAt ? (
                        <Badge tone={overdue ? "danger" : "amber"}>
                          {overdue
                            ? t("student.assigned.overdue")
                            : t("student.assigned.due", { when: formatDateTime(assignment.dueAt) })}
                        </Badge>
                      ) : (
                        <Badge tone="brand">{assignment?.cohort?.name ?? t("student.assigned.assigned")}</Badge>
                      )
                    }
                    note={assignment?.instructions}
                    t={t}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* Open catalog */}
      <section className="mt-10">
        <h2 className="font-display text-lg font-semibold text-ink">{t("student.open.title")}</h2>
        <p className="text-sm text-ink-soft">{t("student.open.hint")}</p>

        {openScenarios.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              title={t("student.open.empty.title")}
              description={t("student.open.empty.description")}
            />
          </div>
        ) : (
          <ul className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {openScenarios.map(({ scenario }) => (
              <li key={scenario.id}>
                <ScenarioCard scenario={scenario} t={t} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent results */}
      {history.length > 0 ? (
        <section className="mt-10">
          <div className="flex items-end justify-between gap-4">
            <h2 className="font-display text-lg font-semibold text-ink">{t("student.recent.title")}</h2>
            <Link href="/student/results" className="text-sm font-semibold text-brand hover:underline">
              {t("student.recent.viewAll")} →
            </Link>
          </div>
          <Card className="mt-3 overflow-hidden p-0">
            <ul className="divide-y divide-line">
              {history.map((attempt) => {
                const percent = attempt.maxScore > 0 ? Math.round((attempt.score / attempt.maxScore) * 100) : 0;
                const ok = percent >= attempt.scenario.passScore;
                return (
                  <li key={attempt.id}>
                    <Link
                      href={`/student/results/${attempt.id}`}
                      className="flex flex-wrap items-center gap-3 px-5 py-3.5 transition hover:bg-surface-muted/60"
                    >
                      <Badge tone={PLATFORM_TONE[attempt.scenario.platform]}>
                        {platformLabel(attempt.scenario.platform)}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{attempt.scenario.title}</span>
                      <span className="text-xs text-ink-faint">
                        {attempt.status === "EXPIRED" ? `${t("student.recent.timedOut")} · ` : ""}
                        {formatDateTime(attempt.submittedAt ?? attempt.startedAt)}
                      </span>
                      <span className={cn("font-mono text-sm font-semibold", ok ? "text-teal" : "text-amber")}>
                        {attempt.score}/{attempt.maxScore} ({percent}%)
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        </section>
      ) : null}
    </div>
  );
}

type ScenarioCardData = {
  id: string;
  title: string;
  summary: string;
  objective?: string;
  platform: Platform;
  difficulty: string;
  timeLimitSec: number;
  tags: string[];
};

function ScenarioCard({
  scenario,
  badge,
  note,
  t,
}: {
  scenario: ScenarioCardData;
  badge?: React.ReactNode;
  note?: string | null;
  t: Translator;
}) {
  return (
    <Card className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={PLATFORM_TONE[scenario.platform]}>{platformLabel(scenario.platform)}</Badge>
        <Badge tone={DIFFICULTY_TONE[scenario.difficulty] ?? "brand"}>{scenario.difficulty.toLowerCase()}</Badge>
        <Badge tone="neutral">{formatDuration(scenario.timeLimitSec)}</Badge>
        {badge ? <span className="ml-auto">{badge}</span> : null}
      </div>

      <h3 className="mt-3 font-display text-lg font-semibold text-ink">{scenario.title}</h3>
      <p className="mt-1.5 line-clamp-3 text-sm text-ink-soft">{scenario.summary}</p>

      {note ? (
        <p className="mt-3 rounded-xl2 border border-brand/20 bg-brand-soft/50 px-3 py-2 text-xs text-ink-soft">{note}</p>
      ) : null}

      {scenario.tags.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {scenario.tags.slice(0, 4).map((tag) => (
            <li key={tag} className="rounded-full bg-surface-muted px-2.5 py-0.5 text-[11px] font-medium text-ink-faint">
              #{tag}
            </li>
          ))}
        </ul>
      ) : null}

      <form action={startAttempt} className="mt-5 pt-1">
        <input type="hidden" name="scenarioId" value={scenario.id} />
        <Button type="submit" className="w-full sm:w-auto">
          {t("student.startScenario")}
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </Button>
      </form>
    </Card>
  );
}
