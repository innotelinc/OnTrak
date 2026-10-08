import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { attemptScopeFor } from "@/lib/attempt-scope";
import { attemptPercent, ATTEMPT_STATUS_LABELS } from "@/lib/scenarios";
import { normalizeGradingMode } from "@/lib/grading-mode";
import { clearedPassMark } from "@/lib/score-rules";
import { Flash, PageHeader } from "@/components/PageHeader";
import { Badge, ButtonLink, Card, EmptyState } from "@/components/ui";
import { cn, formatDateTime, formatDuration } from "@/lib/cn";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Attempts" };

const STATUS_TONE: Record<string, "teal" | "brand" | "amber" | "pink" | "neutral"> = {
  GRADED: "teal",
  SUBMITTED: "brand",
  EXPIRED: "pink",
  ABANDONED: "neutral",
  IN_PROGRESS: "amber",
};

export default async function AttemptsPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string; scenarioId?: string; status?: string }>;
}) {
  const { flash, error, scenarioId, status } = await searchParams;
  const user = await requireSession();
  const t = await getTranslator();

  // Scenarios are shared, but a student's work is not: an instructor sees the
  // attempts of their own students (plus their own scenarios and
  // assignments). See `attempt-rules.ts`.
  const scope = await attemptScopeFor(user);

  // Scenarios are a shared staff catalog, so the filter lists every scenario
  // rather than only the ones the viewer authored.
  const scenarios = await prisma.scenario.findMany({
    select: { id: true, title: true },
    orderBy: { title: "asc" },
  });

  const attempts = await prisma.attempt.findMany({
    where: {
      ...scope,
      status: status ? (status as "GRADED" | "SUBMITTED" | "EXPIRED" | "ABANDONED" | "IN_PROGRESS") : { not: "IN_PROGRESS" },
      ...(scenarioId ? { scenarioId } : {}),
    },
    include: {
      user: { select: { name: true, email: true } },
      scenario: { select: { title: true, platform: true, passScore: true } },
      checkResults: { select: { label: true, passed: true } },
    },
    orderBy: { submittedAt: "desc" },
    take: 200,
  });

  // Which checks trip students up most? That is the most actionable number here.
  const failureCounts = new Map<string, number>();
  for (const attempt of attempts) {
    for (const result of attempt.checkResults) {
      if (!result.passed) failureCounts.set(result.label, (failureCounts.get(result.label) ?? 0) + 1);
    }
  }
  const hardest = [...failureCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow={t("attempts.eyebrow")}
        title={t("attempts.title")}
        description={t("attempts.description")}
      />
      <Flash flash={flash} error={error} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div>
          {/* Filters */}
          <form className="flex flex-wrap items-end gap-3">
            <label className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
              {t("attempts.filter.scenario")}
              <select
                name="scenarioId"
                defaultValue={scenarioId ?? ""}
                className="mt-1 block rounded-xl2 border border-line bg-surface px-3 py-2 text-sm font-normal text-ink"
              >
                <option value="">{t("attempts.filter.allScenarios")}</option>
                {scenarios.map((scenario) => (
                  <option key={scenario.id} value={scenario.id}>
                    {scenario.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
              {t("attempts.filter.status")}
              <select
                name="status"
                defaultValue={status ?? ""}
                className="mt-1 block rounded-xl2 border border-line bg-surface px-3 py-2 text-sm font-normal text-ink"
              >
                <option value="">{t("attempts.filter.finished")}</option>
                <option value="GRADED">{t("attempts.filter.graded")}</option>
                <option value="EXPIRED">{t("attempts.filter.expired")}</option>
                <option value="ABANDONED">{t("attempts.filter.abandoned")}</option>
                <option value="IN_PROGRESS">{t("attempts.filter.inProgress")}</option>
              </select>
            </label>
            <button
              type="submit"
              className="rounded-full border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink-soft transition hover:border-brand/40 hover:text-brand"
            >
              {t("attempts.apply")}
            </button>
          </form>

          {attempts.length === 0 ? (
            <div className="mt-5">
              <EmptyState title={t("attempts.empty.title")} description={t("attempts.empty.description")} />
            </div>
          ) : (
            <Card className="mt-5 overflow-hidden p-0">
              <ul className="divide-y divide-line">
                {attempts.map((attempt) => {
                  const percent = attemptPercent(attempt);
                  const passed = clearedPassMark({
                    score: attempt.score,
                    maxScore: attempt.maxScore,
                    passScore: attempt.scenario.passScore,
                  });
                  const failed = attempt.checkResults.filter((result) => !result.passed).length;
                  const mode = normalizeGradingMode(attempt.gradingMode);
                  return (
                    <li key={attempt.id}>
                      <Link
                        href={`/instructor/attempts/${attempt.id}`}
                        className="flex flex-wrap items-center gap-3 px-5 py-4 transition hover:bg-surface-muted/60"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-semibold text-ink">{attempt.user.name}</span>
                            <Badge tone={STATUS_TONE[attempt.status] ?? "neutral"}>{ATTEMPT_STATUS_LABELS[attempt.status]}</Badge>
                            <Badge tone={passed ? "teal" : "amber"}>
                              {passed ? t("attempts.badge.passed") : t("attempts.badge.below")}
                            </Badge>
                            <Badge tone={mode === "lab" ? "brand" : "neutral"}>{t(`grading.mode.${mode}`)}</Badge>
                          </div>
                          <p className="mt-1 text-xs text-ink-faint">
                            {t("attempts.meta", {
                              scenario: attempt.scenario.title,
                              when: formatDateTime(attempt.submittedAt ?? attempt.startedAt),
                              duration: formatDuration(attempt.timeSpentSec),
                            })}
                            {failed > 0 ? t("attempts.missed", { count: failed }) : ""}
                          </p>
                        </div>
                        <span className={cn("font-mono text-sm font-semibold tabular-nums", passed ? "text-teal" : "text-amber")}>
                          {attempt.score}/{attempt.maxScore} · {percent}%
                        </span>
                        <svg viewBox="0 0 24 24" className="size-4 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M9 6l6 6-6 6" />
                        </svg>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-4 lg:sticky lg:top-24 lg:h-fit">
          <Card>
            <h2 className="font-display text-base font-semibold text-ink">{t("attempts.hardest")}</h2>
            <p className="mt-1 text-xs text-ink-faint">{t("attempts.hardestHint", { count: attempts.length })}</p>
            {hardest.length === 0 ? (
              <p className="mt-3 text-sm text-ink-soft">{t("attempts.hardestNone")}</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {hardest.map(([label, count]) => (
                  <li key={label} className="rounded-xl2 bg-surface-muted px-3 py-2">
                    <p className="text-sm font-medium text-ink">{label}</p>
                    <p className="text-xs text-ink-faint">{t("attempts.missedTimes", { count })}</p>
                  </li>
                ))}
              </ul>
            )}
            {hardest.length > 0 ? (
              <p className="mt-3 text-xs text-ink-soft">{t("attempts.hardestAdvice")}</p>
            ) : null}
          </Card>

          <Card>
            <h2 className="font-display text-base font-semibold text-ink">{t("attempts.export")}</h2>
            <p className="mt-1 text-xs text-ink-soft">{t("attempts.exportHint", { count: attempts.length })}</p>
            <ButtonLink href="/instructor/scenarios" variant="secondary" size="sm" className="mt-3">
              {t("attempts.manageScenarios")}
            </ButtonLink>
          </Card>
        </div>
      </div>
    </div>
  );
}
