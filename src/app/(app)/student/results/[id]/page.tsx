import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { attemptPercent, ATTEMPT_STATUS_LABELS, toDefinition } from "@/lib/scenarios";
import { Badge, ButtonLink, Card, ProgressBar } from "@/components/ui";
import { certificateViewFor, readStoredCertificate } from "@/lib/certificates";
import { certificateCode } from "@/lib/credentials";
import { PageHeader } from "@/components/PageHeader";
import { cn, formatDateTime, formatDuration } from "@/lib/cn";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Attempt report" };

export default async function ResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const t = await getTranslator();

  const attempt = await prisma.attempt.findUnique({
    where: { id },
    include: {
      scenario: true,
      user: { select: { id: true, name: true, email: true } },
      checkResults: { orderBy: { label: "asc" } },
    },
  });

  if (!attempt) notFound();
  if (attempt.userId !== user.id && user.role === "STUDENT") notFound();

  // "Attempt 2 of 3" needs this student's own history for this scenario.
  const attemptNumber = await prisma.attempt.count({
    where: { userId: attempt.userId, scenarioId: attempt.scenarioId, startedAt: { lte: attempt.startedAt } },
  });

  const definition = toDefinition(attempt.scenario);
  const percent = attemptPercent(attempt);
  const passed = percent >= attempt.scenario.passScore;
  const earned = attempt.checkResults.filter((result) => result.passed);

  // A pass earns a certificate: a tamper-evident completion record, stored on
  // the attempt when it was graded, so the printed code can be checked later
  // (see /verify) and keeps verifying after a re-grade.
  const certificateFacts = {
    learnerId: attempt.userId,
    learnerName: attempt.user.name,
    scenarioId: attempt.scenarioId,
    scenarioTitle: attempt.scenario.title,
    platform: attempt.scenario.platform,
    score: attempt.score,
    maxScore: attempt.maxScore,
    passScore: attempt.scenario.passScore,
    completedAt: attempt.gradedAt ?? attempt.submittedAt ?? attempt.startedAt,
    skills: attempt.scenario.tags,
  };
  const certificateView = certificateViewFor(certificateFacts, readStoredCertificate(attempt));
  const revokedAt = certificateView?.revokedAt ?? null;
  const certificate = certificateView && !revokedAt ? certificateView.record : null;
  const certificateSkills = certificate?.skills ?? [];
  // The record attests the result *at issue time*, so a re-grade that moved the
  // score leaves it — and the code on it — untouched. Say so, rather than
  // showing two numbers that disagree with no explanation.
  const certificateRegraded = Boolean(certificate) && certificate?.percent !== percent;
  const penalty = (definition.hints ?? [])
    .filter((hint) => attempt.hintsUsed.includes(hint.id))
    .reduce((sum, hint) => sum + (hint.penalty ?? 0), 0);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        eyebrow={attempt.status === "EXPIRED" ? t("report.expired.eyebrow") : t("report.eyebrow")}
        title={attempt.scenario.title}
        description={
          <>
            {t("report.meta", { name: attempt.user.name, when: formatDateTime(attempt.startedAt) })}
            {attempt.submittedAt
              ? t("report.meta.finished", { when: formatDateTime(attempt.submittedAt) })
              : ""}
          </>
        }
        actions={
          <ButtonLink
            href={user.role === "STUDENT" ? "/student" : "/instructor/attempts"}
            variant="secondary"
            size="sm"
          >
            {user.role === "STUDENT" ? t("report.backQueue") : t("report.backAttempts")}
          </ButtonLink>
        }
      />

      {/* Score banner */}
      <Card className="relative mt-6 overflow-hidden">
        <span
          className={cn("absolute -top-16 -right-12 size-56 rounded-full opacity-15", passed ? "bg-teal" : "bg-amber")}
          aria-hidden
        />
        <div className="relative flex flex-wrap items-center justify-between gap-6">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={passed ? "teal" : attempt.status === "EXPIRED" ? "danger" : "amber"}>
                {passed
                  ? t("report.passed")
                  : attempt.status === "EXPIRED"
                    ? t("report.timedOut")
                    : t("report.below")}
              </Badge>
              <Badge tone="neutral">{ATTEMPT_STATUS_LABELS[attempt.status]}</Badge>
              <Badge tone="neutral">{t("report.passMark", { percent: attempt.scenario.passScore })}</Badge>
            </div>
            <p className="mt-4 font-display text-5xl font-semibold text-ink">
              {percent}
              <span className="text-2xl text-ink-faint">%</span>
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              {t("report.points", { score: attempt.score, max: attempt.maxScore })}
              {penalty > 0 ? t("report.pointsPenalty", { count: penalty }) : ""}
            </p>
          </div>

          <div className="w-full max-w-xs space-y-3">
            <ProgressBar value={percent} tone={passed ? "teal" : "amber"} />
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-faint">{t("report.checksPassed")}</dt>
                <dd className="font-semibold text-ink">
                  {earned.length}/{attempt.checkResults.length}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-faint">{t("report.timeOnTask")}</dt>
                <dd className="font-mono text-ink">{formatDuration(attempt.timeSpentSec)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-faint">{t("report.attempt")}</dt>
                <dd className="text-ink">#{attemptNumber}</dd>
              </div>
            </dl>
          </div>
        </div>
      </Card>

      {/* Per-check breakdown */}
      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold text-ink">{t("report.breakdown")}</h2>
        <p className="text-sm text-ink-soft">{t("report.breakdownHint")}</p>

        <ul className="mt-4 space-y-2.5">
          {attempt.checkResults.map((result) => (
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

      {/* Certificate — only work that cleared the pass mark earns one */}
      {certificate ? (
        <section className="mt-8">
          <h2 className="font-display text-lg font-semibold text-ink">{t("certificate.title")}</h2>
          <p className="text-sm text-ink-soft">{t("certificate.hint")}</p>

          {certificateRegraded ? (
            <p className="mt-3 rounded-xl2 border border-amber/25 bg-amber/10 px-3 py-2 text-sm text-ink-soft">
              {t("certificate.regraded", { percent: certificate?.percent ?? 0 })}
            </p>
          ) : null}

          <Card className="mt-4 border-teal/30">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
                  {t("certificate.code")}
                </p>
                <p className="mt-1 font-mono text-lg font-semibold text-ink">
                  {certificateCode(certificate)}
                </p>
              </div>
              <Badge tone="teal">{t("certificate.issued")}</Badge>
            </div>

            <dl className="mt-4 space-y-1.5 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-ink-faint">{t("certificate.learner")}</dt>
                <dd className="text-ink">{certificate.learnerName}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-ink-faint">{t("certificate.completedAt")}</dt>
                <dd className="font-mono text-xs text-ink">{formatDateTime(new Date(certificate.completedAt))}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-ink-faint">{t("certificate.issuer")}</dt>
                <dd className="text-ink">{certificate.issuer}</dd>
              </div>
            </dl>

            {certificateSkills.length > 0 ? (
              <div className="mt-4">
                <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
                  {t("certificate.skills")}
                </p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {certificateSkills.map((skill) => (
                    <li key={skill}>
                      <Badge tone="neutral">{skill}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-semibold text-brand">
                {t("certificate.json")}
              </summary>
              <pre className="mt-3 max-h-72 overflow-auto rounded-xl2 border border-line bg-surface-muted px-4 py-3 font-mono text-[11px] leading-relaxed text-ink-soft">
                {JSON.stringify(certificate, null, 2)}
              </pre>
            </details>

            <p className="mt-4 text-sm text-ink-soft">
              {t("certificate.verifyHint")}{" "}
              <Link href="/verify" className="font-semibold text-brand hover:underline">
                {t("certificate.verifyLink")} →
              </Link>
            </p>
          </Card>
        </section>
      ) : null}

      {/* A re-grade can take a certificate away, and that has to be visible */}
      {certificateView && revokedAt ? (
        <section className="mt-8">
          <h2 className="font-display text-lg font-semibold text-ink">
            {t("certificate.revoked.title")}
          </h2>
          <Card className="mt-4 border-pink/25">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="danger">{t("certificate.revoked.badge")}</Badge>
              <span className="font-mono text-sm font-semibold text-ink-faint">
                {certificateCode(certificateView.record)}
              </span>
            </div>
            <p className="mt-3 text-sm text-ink-soft">
              {t("certificate.revoked.body", { when: formatDateTime(revokedAt) })}
            </p>
          </Card>
        </section>
      ) : null}

      {/* Objectives recap + next steps */}
      <section className="mt-8 grid gap-4 md:grid-cols-2">
        <Card>
          <h3 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">{t("report.objectives")}</h3>
          <ul className="mt-3 space-y-2 text-sm text-ink-soft">
            {definition.tasks.map((task) => (
              <li key={task} className="flex gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand" />
                {task}
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <h3 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">{t("report.next")}</h3>
          <ul className="mt-3 space-y-3 text-sm text-ink-soft">
            <li>{t("report.next.body")}</li>
            {!passed ? (
              <li className="rounded-xl2 border border-amber/25 bg-amber/10 px-3 py-2">{t("report.next.failing")}</li>
            ) : (
              <li className="rounded-xl2 border border-teal/25 bg-teal/10 px-3 py-2">{t("report.next.passed")}</li>
            )}
            <li>
              <Link href="/student" className="font-semibold text-brand hover:underline">
                {t("report.findAnother")} →
              </Link>
            </li>
          </ul>
        </Card>
      </section>
    </div>
  );
}
