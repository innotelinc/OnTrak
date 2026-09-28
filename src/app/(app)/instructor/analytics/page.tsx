import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { attemptScopeFor } from "@/lib/attempt-scope";
import {
  summariseAttempts,
  summariseByScenario,
  summariseChecks,
  trendByDay,
  type AttemptRow,
} from "@/lib/analytics-rules";
import { Flash, PageHeader } from "@/components/PageHeader";
import { Badge, Card, EmptyState, ProgressBar, Stat } from "@/components/ui";
import { formatDuration } from "@/lib/cn";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Analytics" };

const TREND_DAYS = 14;

/**
 * Bands for a single check's pass rate. A check is pass/fail, so there is no
 * per-scenario pass mark to colour it against; these are the rough
 * "worth another hint" lines instead.
 */
const CHECK_WEAK = 70;
const CHECK_POOR = 40;

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const { flash, error } = await searchParams;
  const user = await requireSession();
  if (user.role === "STUDENT") {
    redirect("/student?error=" + encodeURIComponent("Instructor access is required for that."));
  }
  const t = await getTranslator();

  // Same visibility rule as the attempts list: the dashboard must not leak
  // another instructor's cohort results. See `attempt-rules.ts`.
  const scope = await attemptScopeFor(user);

  const [attempts, scenarios] = await Promise.all([
    prisma.attempt.findMany({
      where: { ...scope, status: { in: ["GRADED", "SUBMITTED", "EXPIRED"] } },
      select: {
        id: true,
        scenarioId: true,
        status: true,
        startedAt: true,
        submittedAt: true,
        timeSpentSec: true,
        score: true,
        maxScore: true,
        checkResults: { select: { checkId: true, label: true, passed: true } },
      },
      orderBy: { submittedAt: "desc" },
      take: 5000,
    }),
    prisma.scenario.findMany({
      select: { id: true, title: true, passScore: true },
      orderBy: { title: "asc" },
    }),
  ]);

  const titles = new Map(scenarios.map((scenario) => [scenario.id, scenario.title]));
  const passScoreByScenario = Object.fromEntries(scenarios.map((scenario) => [scenario.id, scenario.passScore]));

  const rows: AttemptRow[] = attempts.map((attempt) => ({
    id: attempt.id,
    scenarioId: attempt.scenarioId,
    status: attempt.status,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    timeSpentSec: attempt.timeSpentSec,
    score: attempt.score,
    maxScore: attempt.maxScore,
  }));

  const overall = summariseAttempts(rows, passScoreByScenario);
  const byScenario = summariseByScenario(rows, passScoreByScenario);
  const checks = summariseChecks(attempts.flatMap((attempt) => attempt.checkResults));
  const trend = trendByDay(rows, TREND_DAYS, new Date());

  const hardest = checks.slice(0, 8);
  const trendMax = Math.max(1, ...trend.map((bucket) => bucket.attempts));

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow={t("analytics.eyebrow")}
        title={t("analytics.title")}
        description={t("analytics.description")}
      />
      <Flash flash={flash} error={error} />

      {rows.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title={t("analytics.empty.title")}
            description={t("analytics.empty.description")}
          />
        </div>
      ) : (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label={t("analytics.stat.finished")}
              value={overall.attempts}
              hint={t("analytics.hint.trend", { days: TREND_DAYS })}
              tone="sky"
            />
            <Stat
              label={t("analytics.stat.average")}
              value={`${overall.averagePercent}%`}
              hint={t("analytics.hint.passedAgainst", { count: overall.passed, mark: overall.passMark })}
              tone={overall.averagePercent >= overall.passMark ? "teal" : "amber"}
            />
            <Stat
              label={t("analytics.stat.passRate")}
              value={`${overall.passRate}%`}
              hint={t("analytics.hint.passMark", { mark: overall.passMark })}
              tone={overall.passRate >= overall.passMark ? "teal" : "pink"}
            />
            <Stat
              label={t("analytics.stat.median")}
              value={formatDuration(overall.medianTimeSec)}
              hint={t("analytics.hint.p90", { time: formatDuration(overall.p90TimeSec) })}
              tone="brand"
            />
          </div>

          <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <section>
              <h2 className="font-display text-lg font-semibold text-ink">
                {t("analytics.trend.title", { days: TREND_DAYS })}
              </h2>
              <Card className="mt-3 p-5">
                <ul className="space-y-2.5">
                  {trend.map((bucket) => (
                    <li key={bucket.date} className="flex items-center gap-3">
                      <span className="w-20 shrink-0 font-mono text-xs text-ink-faint">{bucket.date.slice(5)}</span>
                      <ProgressBar value={Math.round((bucket.attempts / trendMax) * 100)} tone="brand" className="flex-1" />
                      <span className="w-24 shrink-0 text-right text-xs text-ink-soft">
                        {bucket.attempts} · {bucket.averagePercent}%
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>

              <h2 className="mt-8 font-display text-lg font-semibold text-ink">{t("analytics.byScenario")}</h2>
              <Card className="mt-3 overflow-hidden p-0">
                <ul className="divide-y divide-line">
                  {byScenario.map((stat) => (
                    <li key={stat.scenarioId} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                        {titles.get(stat.scenarioId) ?? stat.scenarioId}
                      </span>
                      <Badge tone="neutral">{stat.attempts} attempt(s)</Badge>
                      <span className="text-xs text-ink-faint">avg {stat.averagePercent}%</span>
                      <span className="text-xs text-ink-faint">
                        {t("analytics.mark", { score: stat.passScore })}
                      </span>
                      <Badge tone={stat.passRate >= stat.passScore ? "teal" : "amber"}>
                        {stat.passRate}% pass
                      </Badge>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>

            <section>
              <h2 className="font-display text-lg font-semibold text-ink">{t("analytics.hardest")}</h2>
              <p className="mt-1 text-xs text-ink-faint">{t("analytics.hardestHint")}</p>
              <Card className="mt-3 overflow-hidden p-0">
                <ul className="divide-y divide-line">
                  {hardest.map((check) => (
                    <li key={check.checkId} className="px-5 py-3.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{check.label}</span>
                        <Badge
                          tone={
                            check.passRate >= CHECK_WEAK ? "teal" : check.passRate >= CHECK_POOR ? "amber" : "pink"
                          }
                        >
                          {check.passRate}%
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-ink-faint">
                        passed {check.passed}/{check.attempts}
                      </p>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
