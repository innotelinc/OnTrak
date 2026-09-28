import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { attemptScopeFor } from "@/lib/attempt-scope";
import { attemptPercent, ATTEMPT_STATUS_LABELS, coerceSubmittedState, toDefinition } from "@/lib/scenarios";
import { canRegrade } from "@/lib/grading-rules";
import { gradeAttempt } from "@/lib/sim/grade";
import { regradeAttempt } from "@/app/actions/instructor";
import { Flash, PageHeader } from "@/components/PageHeader";
import { Badge, Button, ButtonLink, Card, ProgressBar } from "@/components/ui";
import { cn, formatDateTime, formatDuration } from "@/lib/cn";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Attempt review" };

export default async function AttemptReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const { id } = await params;
  const { flash, error } = await searchParams;
  const user = await requireSession();
  const t = await getTranslator();

  // A scoped lookup rather than `findUnique`: an attempt outside the viewer's
  // scope (another instructor's cohort, an unknown id) is simply not found.
  const scope = await attemptScopeFor(user);
  const attempt = await prisma.attempt.findFirst({
    where: { id, ...scope },
    include: {
      user: { select: { id: true, name: true, email: true } },
      scenario: true,
      assignment: { include: { cohort: { select: { name: true } } } },
      checkResults: { orderBy: { label: "asc" } },
    },
  });
  if (!attempt) notFound();

  const definition = toDefinition(attempt.scenario);
  const percent = attemptPercent(attempt);
  const passed = percent >= attempt.scenario.passScore;

  // Re-derive the report live so the page shows what a re-grade would produce,
  // and whether the stored results are stale.
  const state = coerceSubmittedState(attempt.snapshot, definition);
  const live = gradeAttempt(definition, state, attempt.scenario.passScore);
  // Compare the *identity* of each result, not just how many there are: a check
  // that flipped from pass to fail (with another flipping the other way) leaves
  // both the count and the total unchanged, yet the stored report is stale.
  const storedChecks = new Map(attempt.checkResults.map((result) => [result.checkId, result.passed]));
  const stale =
    live.score !== attempt.score ||
    live.maxScore !== attempt.maxScore ||
    live.results.length !== storedChecks.size ||
    live.results.some((result) => storedChecks.get(result.checkId) !== result.passed);

  const history = state.machine.history;
  const hintsUsed = (definition.hints ?? []).filter((hint) => attempt.hintsUsed.includes(hint.id));

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        eyebrow={t("attempts.review.eyebrow")}
        title={attempt.scenario.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{ATTEMPT_STATUS_LABELS[attempt.status]}</Badge>
            <Badge tone={passed ? "teal" : "amber"}>
              {passed ? t("attempts.badge.passed") : t("attempts.badge.below")}
            </Badge>
            <span className="text-xs text-ink-faint">
              {attempt.user.name} · {attempt.user.email}
              {attempt.assignment?.cohort ? ` · ${attempt.assignment.cohort.name}` : ""}
            </span>
          </span>
        }
        actions={
          <>
            <ButtonLink href="/instructor/attempts" variant="secondary" size="sm">
              {t("attempts.review.all")}
            </ButtonLink>
            {canRegrade(attempt.status) ? (
              <form action={regradeAttempt}>
                <input type="hidden" name="attemptId" value={attempt.id} />
                <Button type="submit" size="sm">
                  {t("attempts.review.regrade")}
                </Button>
              </form>
            ) : null}
          </>
        }
      />
      <Flash flash={flash} error={error} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <Card>
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div>
                <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
                  {t("attempts.review.score")}
                </p>
                <p className="font-display text-4xl font-semibold text-ink">
                  {percent}
                  <span className="text-2xl text-ink-faint">%</span>
                </p>
                <p className="mt-1 text-sm text-ink-soft">
                  {t("attempts.review.scoreHint", {
                    score: attempt.score,
                    max: attempt.maxScore,
                    pass: attempt.scenario.passScore,
                  })}
                </p>
              </div>
              <div className="w-full max-w-xs">
                <ProgressBar value={percent} tone={passed ? "teal" : "amber"} />
                <p className="mt-2 text-xs text-ink-faint">
                  {t("attempts.review.time", {
                    duration: formatDuration(attempt.timeSpentSec),
                    started: formatDateTime(attempt.startedAt),
                  })}
                </p>
              </div>
            </div>
          </Card>

          {stale ? (
            <Card className="border-amber/35">
              <p className="text-sm text-ink-soft">
                <span className="font-semibold text-amber">{t("attempts.review.stale")}</span>{" "}
                {t("attempts.review.staleBody", { score: live.score, max: live.maxScore })}
              </p>
            </Card>
          ) : null}

          <section>
            <h2 className="font-display text-lg font-semibold text-ink">{t("attempts.review.checks")}</h2>
            <ul className="mt-3 space-y-2">
              {(attempt.checkResults.length > 0 ? attempt.checkResults : live.results.map((result) => ({
                id: result.checkId,
                label: result.label,
                passed: result.passed,
                points: result.points,
                maxPoints: result.maxPoints,
                detail: result.detail,
              }))).map((result) => (
                <li key={result.id}>
                  <Card className={cn("p-4", result.passed ? "border-teal/30" : "border-pink/25")}>
                    <div className="flex flex-wrap items-start gap-3">
                      <span
                        className={cn(
                          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-white",
                          result.passed ? "bg-teal" : "bg-pink",
                        )}
                      >
                        <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d={result.passed ? "M5 13l4 4L19 7" : "M6 6l12 12M18 6 6 18"} />
                        </svg>
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-ink">{result.label}</p>
                        <p className="mt-0.5 text-sm text-ink-soft">{result.detail}</p>
                      </div>
                      <span className={cn("font-mono text-xs font-semibold", result.passed ? "text-teal" : "text-pink")}>
                        {result.points}/{result.maxPoints}
                      </span>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          </section>

          {/* Command log */}
          <section>
            <h2 className="font-display text-lg font-semibold text-ink">{t("attempts.review.commands")}</h2>
            <p className="text-sm text-ink-soft">
              {t("attempts.review.commandsHint", { count: history.length })}
            </p>
            <div className="mt-3 max-h-[28rem] overflow-auto rounded-xl2 border border-[#2c2350] bg-[#141029] px-4 py-3">
              {history.length === 0 ? (
                <p className="font-mono text-xs text-white/50">{t("attempts.review.noCommands")}</p>
              ) : (
                <ol className="space-y-1">
                  {history.map((entry) => (
                    <li key={entry.index} className="font-mono text-[12px] leading-relaxed">
                      <span className="mr-2 text-white/35">{String(entry.index).padStart(3, "0")}</span>
                      <span className={entry.exitCode === 0 ? "text-[#d6d0ff]" : "text-[#ffb3c7]"}>{entry.input}</span>
                      {entry.exitCode !== 0 ? <span className="ml-2 text-[#ff8fa8]">→ exit {entry.exitCode}</span> : null}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>
        </div>

        <div className="space-y-4 lg:sticky lg:top-24 lg:h-fit">
          <Card>
            <h2 className="font-display text-base font-semibold text-ink">{t("attempts.review.submission")}</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-faint">{t("attempts.review.started")}</dt>
                <dd className="text-right text-ink">{formatDateTime(attempt.startedAt)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-faint">{t("attempts.review.submitted")}</dt>
                <dd className="text-right text-ink">
                  {attempt.submittedAt ? formatDateTime(attempt.submittedAt) : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-faint">{t("attempts.review.deadline")}</dt>
                <dd className="text-right text-ink">{formatDateTime(attempt.expiresAt)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-faint">{t("attempts.review.seed")}</dt>
                <dd className="font-mono text-xs text-ink">{attempt.seed}</dd>
              </div>
            </dl>
          </Card>

          <Card>
            <h2 className="font-display text-base font-semibold text-ink">{t("attempts.review.hints")}</h2>
            {hintsUsed.length === 0 ? (
              <p className="mt-2 text-sm text-ink-soft">{t("attempts.review.noHints")}</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {hintsUsed.map((hint) => (
                  <li key={hint.id} className="rounded-xl2 border border-amber/25 bg-amber/10 px-3 py-2 text-xs text-ink-soft">
                    {hint.text}
                    {hint.penalty ? <span className="ml-1 font-semibold text-amber">(−{hint.penalty})</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="font-display text-base font-semibold text-ink">{t("attempts.review.notes")}</h2>
            {state.machine.notes.length === 0 ? (
              <p className="mt-2 text-sm text-ink-soft">{t("attempts.review.noNotes")}</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {state.machine.notes.map((note, index) => (
                  <li key={index} className="border-l-2 border-brand/40 pl-3 text-sm text-ink-soft">
                    {note}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="font-display text-base font-semibold text-ink">{t("attempts.review.scenario")}</h2>
            <p className="mt-2 text-sm text-ink-soft">{definition.objective}</p>
            <Link
              href={`/instructor/scenarios/${attempt.scenarioId}`}
              className="mt-3 inline-block text-sm font-semibold text-brand hover:underline"
            >
              {t("attempts.review.openScenario")} →
            </Link>
          </Card>
        </div>
      </div>
    </div>
  );
}
