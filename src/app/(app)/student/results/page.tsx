import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { sweepExpiredAttempts } from "@/lib/scenarios";
import { Badge, Card, EmptyState, ProgressBar } from "@/components/ui";
import { PageHeader } from "@/components/PageHeader";
import { cn, formatDateTime, formatDuration } from "@/lib/cn";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "My results" };

export default async function ResultsIndex() {
  const user = await requireSession();
  const t = await getTranslator();
  await sweepExpiredAttempts(user.id);

  const attempts = await prisma.attempt.findMany({
    where: { userId: user.id, status: { not: "IN_PROGRESS" } },
    include: {
      scenario: { select: { title: true, platform: true, difficulty: true, passScore: true } },
      checkResults: { select: { passed: true } },
    },
    orderBy: { submittedAt: "desc" },
    take: 100,
  });

  // A discarded attempt was never graded — its score is a default zero — so it
  // must not drag the average down. Expired attempts *were* graded, so they stay.
  const graded = attempts.filter((attempt) => attempt.status !== "ABANDONED" && attempt.maxScore > 0);
  const average =
    graded.length > 0
      ? Math.round(graded.reduce((sum, attempt) => sum + (attempt.score / attempt.maxScore) * 100, 0) / graded.length)
      : 0;
  // Personal bests are computed up front, so the badge marks the attempt that
  // actually holds the record rather than whichever row happened to beat the one
  // before it in the (newest-first) list.
  const bestByScenario = new Map<string, number>();
  for (const attempt of graded) {
    const percent = Math.round((attempt.score / attempt.maxScore) * 100);
    const best = bestByScenario.get(attempt.scenarioId);
    if (best === undefined || percent > best) bestByScenario.set(attempt.scenarioId, percent);
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader eyebrow={t("results.eyebrow")} title={t("results.title")} description={t("results.description")} />

      {attempts.length === 0 ? (
        <div className="mt-6">
          <EmptyState title={t("results.empty.title")} description={t("results.empty.description")} />
        </div>
      ) : (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <Card className="p-5">
              <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
                {t("results.stat.attempts")}
              </p>
              <p className="mt-1 font-display text-3xl font-semibold text-ink">{attempts.length}</p>
            </Card>
            <Card className="p-5">
              <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
                {t("results.stat.average")}
              </p>
              <p className="mt-1 font-display text-3xl font-semibold text-ink">{average}%</p>
              <ProgressBar value={average} tone={average >= 70 ? "teal" : "amber"} className="mt-3" />
            </Card>
            <Card className="p-5">
              <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
                {t("results.stat.checks")}
              </p>
              <p className="mt-1 font-display text-3xl font-semibold text-teal">
                {attempts.reduce((sum, attempt) => sum + attempt.checkResults.filter((c) => c.passed).length, 0)}
              </p>
              <p className="mt-1 text-xs text-ink-faint">
                {t("results.stat.checksHint", {
                  count: attempts.reduce((sum, attempt) => sum + attempt.checkResults.length, 0),
                })}
              </p>
            </Card>
          </div>

          <Card className="mt-6 overflow-hidden p-0">
            <ul className="divide-y divide-line">
              {attempts.map((attempt) => {
                const percent = attempt.maxScore > 0 ? Math.round((attempt.score / attempt.maxScore) * 100) : 0;
                const passed = percent >= attempt.scenario.passScore;
                const passedChecks = attempt.checkResults.filter((result) => result.passed).length;
                const isBest =
                  attempt.status !== "ABANDONED" &&
                  attempt.maxScore > 0 &&
                  percent === bestByScenario.get(attempt.scenarioId);

                return (
                  <li key={attempt.id}>
                    <Link
                      href={`/student/results/${attempt.id}`}
                      className="flex flex-wrap items-center gap-3 px-5 py-4 transition hover:bg-surface-muted/60"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold text-ink">{attempt.scenario.title}</span>
                          <Badge tone={attempt.scenario.platform === "LINUX" ? "amber" : attempt.scenario.platform === "WINDOWS" ? "sky" : "pink"}>
                            {attempt.scenario.platform.toLowerCase()}
                          </Badge>
                          {attempt.status === "EXPIRED" ? (
                            <Badge tone="danger">{t("results.badge.timedOut")}</Badge>
                          ) : null}
                          {attempt.status === "ABANDONED" ? (
                            <Badge tone="neutral">{t("results.badge.discarded")}</Badge>
                          ) : null}
                          {isBest ? <Badge tone="teal">{t("results.badge.best")}</Badge> : null}
                        </div>
                        <p className="mt-1 text-xs text-ink-faint">
                          {t("results.row.meta", {
                            when: formatDateTime(attempt.submittedAt ?? attempt.startedAt),
                            duration: formatDuration(attempt.timeSpentSec),
                            passed: passedChecks,
                            total: attempt.checkResults.length,
                          })}
                        </p>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="w-24">
                          <ProgressBar value={percent} tone={passed ? "teal" : "amber"} />
                        </div>
                        <span className={cn("font-mono text-sm font-semibold tabular-nums", passed ? "text-teal" : "text-amber")}>
                          {percent}%
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
