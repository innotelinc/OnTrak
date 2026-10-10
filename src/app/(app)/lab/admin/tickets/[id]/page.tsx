import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requireLabStaff } from "@/lib/lab-admin-access";
import { scenarioKey } from "@/lib/lab/admin";
import { ScenarioError } from "@/lib/lab/scenarios";
import { labRuntimeForPage, type LabRuntime } from "@/lib/lab/service";
import { feedbackText, type TicketForm, type TicketGrade } from "@/lib/lab/tickets";
import { scoreReportSummaryLine } from "@/lib/lab/models";
import { LabAdminPanel, LabOff } from "@/components/lab/LabAdminPanel";
import { Alert, Badge, Card, EmptyState, SectionHeading, Stat } from "@/components/ui";
import { formatDateTime } from "@/lib/cn";
import { formatFixed } from "@/lib/lab/scoring";

export const metadata: Metadata = { title: "Lab — ticket" };

/**
 * One write-up, as it was answered and as it was marked.
 *
 * This is `admin.py`'s `/admin/tickets/{session_id}`, and the one decision worth naming is
 * *which* answers are shown. A marked ticket is read from `ticketValues` — the answers that
 * were handed in — and only a ticket with no grade falls back to `ticketDraft`. That ordering
 * is the difference between a marking record and a live view of somebody's typing: an
 * instructor opening this page while a student is still writing must see the submitted
 * answers, never the half-finished ones, which is the same split `store.ts` draws.
 *
 * The feedback text is the lab's own `feedbackText` — the same function the CLI prints and the
 * student's own page renders — so the sentence an instructor reads here and the sentence the
 * student was given cannot drift apart.
 */
export default async function LabAdminTicketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireLabStaff();
  const { id } = await params;
  const { runtime, reason } = await labRuntimeForPage();

  return (
    <LabAdminPanel
      section="tickets"
      title="One write-up"
      description="What the student handed in, and the mark the rubric gave it."
      actions={
        <Link href="/lab/admin/tickets" className="text-sm font-semibold text-brand hover:underline">
          ← All tickets
        </Link>
      }
    >
      {runtime === null ? <LabOff reason={reason} /> : <Ticket runtime={runtime} id={id} />}
    </LabAdminPanel>
  );
}

async function Ticket({ runtime, id }: { runtime: LabRuntime; id: string }) {
  const sessionId = Number(id);
  if (!Number.isInteger(sessionId)) notFound();

  const session = await runtime.store.getSession(sessionId);
  if (session === null) notFound();

  let scenarioId = session.scenarioId;
  let form: TicketForm | null = null;
  try {
    const scenario = runtime.repository.get(session.scenarioId);
    scenarioId = scenario.id;
    // The repository parsed `ticket.form` with `loadForm` at load time, so this is the same
    // object the grader and the student's page read — not a second parse.
    form = scenario.ticketForm as TicketForm | null;
  } catch (error) {
    if (!(error instanceof ScenarioError)) throw error;
  }

  const grade = await runtime.store.latestTicket(sessionId);
  // Submitted answers first; a draft only when there is no marked ticket (see the header).
  const answers = grade === null
    ? await runtime.store.ticketDraft(sessionId)
    : await runtime.store.ticketValues(sessionId);
  const attempts = await runtime.store.ticketsForSession(sessionId);
  const report = await runtime.store.latestReport(sessionId);
  const feedback = form !== null && grade !== null ? feedbackText(form, grade) : "";

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Student" value={session.student} />
        <Stat label="Scenario" value={scenarioId} />
        <Stat
          label="Ticket mark"
          value={grade === null ? "not marked" : `${formatFixed(grade.score, 1)}%`}
        />
        <Stat label="Attempts" value={String(attempts.length)} />
      </div>

      {grade === null ? (
        <Alert tone="amber" title="Nothing handed in yet">
          Nothing has been marked for this session
          {Object.keys(answers).length > 0
            ? ", and what is shown below is a draft the student is still writing — it is not a mark."
            : "."}
        </Alert>
      ) : null}

      <Card className="space-y-3">
        <SectionHeading title="The session" description="State, machine and machine-side grade." />
        <ul className="space-y-1 text-xs">
          <li className="flex justify-between gap-3">
            <span className="text-ink-faint">State</span>
            <span className="text-ink-soft">{session.state}</span>
          </li>
          <li className="flex justify-between gap-3">
            <span className="text-ink-faint">Machine</span>
            <span className="font-mono text-ink-soft">{session.hostIp || "—"}</span>
          </li>
          <li className="flex justify-between gap-3">
            <span className="text-ink-faint">Started</span>
            <span className="font-mono text-ink-soft">{formatDateTime(session.createdAt)}</span>
          </li>
          <li className="flex justify-between gap-3">
            <span className="text-ink-faint">Machine grade</span>
            <span className="font-mono text-ink-soft">
              {report === null ? "not graded" : scoreReportSummaryLine(report)}
            </span>
          </li>
          <li className="flex justify-between gap-3">
            <span className="text-ink-faint">Scenario key</span>
            <span className="font-mono text-ink-soft">{scenarioKey(session.scenarioId, session.workload)}</span>
          </li>
        </ul>
        <Link
          href={`/lab/sessions/${String(session.id)}`}
          className="text-xs font-semibold text-brand hover:underline"
        >
          The session as the student saw it →
        </Link>
      </Card>

      <Card className="space-y-3">
        <SectionHeading
          title="The answers"
          description={
            form === null
              ? "This scenario declares no form, so the answers are shown raw."
              : `${form.title} · pass mark ${formatFixed(form.passScore, 0)}%`
          }
        />
        {Object.keys(answers).length === 0 ? (
          <EmptyState title="No answers recorded" />
        ) : form === null ? (
          <ul className="space-y-2 text-xs">
            {Object.entries(answers).map(([fieldId, value]) => (
              <li key={fieldId}>
                <span className="font-mono text-ink-faint">{fieldId}</span>
                <p className="mt-0.5 text-ink-soft">{value}</p>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="space-y-4">
            {form.fields.map((field) => {
              const outcome = grade?.outcomes.find((entry) => entry.fieldId === field.id) ?? null;
              return (
                <li key={field.id} className="border-t border-line pt-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold text-ink">{field.label}</span>
                    <span className="flex items-center gap-2 text-xs">
                      <span className="text-ink-faint">{formatFixed(field.weight, 0)} pts</span>
                      {field.required ? <Badge tone="neutral">required</Badge> : null}
                      {outcome === null ? null : outcome.passed ? (
                        <Badge tone="teal">pass</Badge>
                      ) : (
                        <Badge tone="pink">fail</Badge>
                      )}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-ink-soft">
                    {answers[field.id]?.trim() ? answers[field.id] : "— not answered —"}
                  </p>
                  {outcome !== null && outcome.detail !== "" ? (
                    <p className="mt-1 text-xs text-ink-faint">{outcome.detail}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {feedback !== "" ? (
        <Card className="space-y-3">
          <SectionHeading
            title="The feedback the student was given"
            description="The lab's own rubric output, word for word."
          />
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl2 border border-line bg-surface px-4 py-3 font-mono text-xs text-ink-soft">
            {feedback}
          </pre>
        </Card>
      ) : null}
    </>
  );
}
