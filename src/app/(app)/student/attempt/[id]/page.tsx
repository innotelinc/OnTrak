import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { readSnapshot, SCENARIO_INCLUDE, secondsRemaining, toDefinition } from "@/lib/scenarios";
import { LOCALE_COOKIE, resolveLocale } from "@/lib/i18n";
import { AttemptRunner } from "@/components/console/AttemptRunner";
import { LocaleProvider } from "@/lib/i18n-client";

export const metadata: Metadata = { title: "Attempt in progress" };
export const dynamic = "force-dynamic";

export default async function AttemptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();

  const attempt = await prisma.attempt.findUnique({
    where: { id },
    include: { scenario: { include: SCENARIO_INCLUDE }, assignment: true },
  });

  if (!attempt) notFound();
  // Students may only ever open their own attempts; staff may observe.
  if (attempt.userId !== user.id && user.role === "STUDENT") notFound();

  if (attempt.status !== "IN_PROGRESS") {
    redirect(`/student/results/${attempt.id}`);
  }

  const definition = toDefinition(attempt.scenario);
  const initialState = readSnapshot(attempt, definition);
  const store = await cookies();
  const locale = resolveLocale(store.get(LOCALE_COOKIE)?.value);

  return (
    <LocaleProvider locale={locale}>
    <AttemptRunner
      attempt={{
        id: attempt.id,
        status: attempt.status,
        expiresAt: attempt.expiresAt.toISOString(),
        startedAt: attempt.startedAt.toISOString(),
        hintsUsed: attempt.hintsUsed,
        serverRemaining: secondsRemaining(attempt),
      }}
      scenario={{
        id: attempt.scenario.id,
        title: attempt.scenario.title,
        objective: attempt.scenario.summary || definition.objective,
        platform: attempt.scenario.platform,
        engine: attempt.scenario.engine,
        difficulty: attempt.scenario.difficulty,
        timeLimitSec: attempt.scenario.timeLimitSec,
        passScore: attempt.scenario.passScore,
      }}
      definition={definition}
      initialState={initialState}
      locale={locale}
      assignment={
        attempt.assignment
          ? { instructions: attempt.assignment.instructions, dueAt: attempt.assignment.dueAt?.toISOString() ?? null }
          : null
      }
    />
    </LocaleProvider>
  );
}
