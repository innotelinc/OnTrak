import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requireSession } from "@/lib/auth";
import {
  checkLabSession,
  completeLabSession,
  endLabSession,
  extendLabSession,
  resetLabSession,
  revealLabHint,
  saveLabWriteUp,
  setLabTimeLimit,
} from "@/app/actions/lab";
import { isUsable, scoreReportSummaryLine, sessionSecondsRemaining } from "@/lib/lab/models";
import { consoleUrl, machineAddress, sessionStatus } from "@/lib/lab/portal";
import { previewKey, readPreview } from "@/lib/lab/preview";
import { hintsUpTo, type Scenario } from "@/lib/lab/scenarios";
import { labRuntimeForPage } from "@/lib/lab/service";
import { SessionError } from "@/lib/lab/sessions";
import { renderFeedback, ticketGradeSummaryLine } from "@/lib/lab/tickets";
import { SessionConsole } from "@/components/lab/SessionConsole";
import { SessionPoller } from "@/components/lab/SessionPoller";
import { WriteUpForm } from "@/components/lab/WriteUpForm";
import { Alert, Badge, Button, Card, EmptyState, ProgressBar, SectionHeading } from "@/components/ui";
import { Flash, PageHeader } from "@/components/PageHeader";
import { formatDateTime } from "@/lib/cn";

export const metadata: Metadata = { title: "Lab session" };

/**
 * One machine, in front of the student who asked for it.
 *
 * The page loads the session, *claims* it if it is ready (which doubles as the heartbeat
 * the reaper reads), and then shows four things in the order a student needs them: where the
 * machine is and how to reach it, the task and its hints, the write-up, and the controls.
 *
 * The two policies the Python's template encoded, kept because they are the product's:
 * stored results are final submissions only (`store.latestReport`), while a check the
 * student ran to see how they are doing is shown from the in-process preview and is never
 * written; and a scenario that declares a ticket cannot be handed in with a required field
 * blank, which the action enforces — the form only marks the field with `*`.
 */
export default async function LabSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const { id } = await params;
  const { flash, error } = await searchParams;
  const user = await requireSession();
  const { runtime, reason } = await labRuntimeForPage();

  if (runtime === null) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <PageHeader eyebrow="OnTrak Lab" title="Not available" />
        <Alert tone="amber" title="OnTrak Lab is not running on this deployment">
          {reason}
        </Alert>
      </div>
    );
  }

  const sessionId = Number(id);
  if (!Number.isInteger(sessionId) || sessionId <= 0) notFound();

  const student = user.email.trim().toLowerCase();
  const staff = user.role === "INSTRUCTOR" || user.role === "ADMIN";
  let session;
  try {
    session = await runtime.manager.getOwnedSession(student, sessionId, staff);
  } catch (caught) {
    if (caught instanceof SessionError) notFound();
    throw caught;
  }

  const scenario = runtime.repository.get(session.scenarioId);

  // Claiming on load is also the activity heartbeat, and it is what turns a pooled machine
  // into this student's. `claimForUse` refuses a machine somebody else holds.
  if (session.state === "ready") {
    session = await runtime.manager.claimForUse(session);
  } else if (session.state === "in_use" || session.state === "passed") {
    await runtime.manager.touch(session);
  }

  const key = previewKey(student, sessionId);
  const report = session.id === null ? null : await runtime.store.latestReport(session.id);
  const preview = readPreview(key);
  const submitted = session.id === null ? null : await runtime.store.latestTicket(session.id);
  const form = runtime.manager.ticketFormFor(session);
  // The answers to show: what was handed in once it has been, and what has been typed so
  // far until then. A draft is not a grade, and a grade is not a draft — the two live in
  // different places in the store, and the page reads the one that fits the session's state.
  const answers =
    session.id === null
      ? {}
      : submitted !== null
        ? await runtime.store.ticketValues(session.id)
        : await runtime.store.ticketDraft(session.id);

  const events = session.id === null ? [] : await runtime.store.eventsFor(session.id, 15);
  const url = consoleUrl(runtime.settings, session, scenario);
  const address = machineAddress(runtime.settings, scenario, session);
  const status = sessionStatus(session, url !== "");
  const handedIn = session.completedAt !== "";
  const remaining = sessionSecondsRemaining(session);
  const gradeRows =
    submitted !== null && form !== null
      ? renderFeedback(form, submitted)
      : preview?.grade != null && form !== null
        ? renderFeedback(form, preview.grade)
        : [];

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        eyebrow={staff ? `Lab session ${sessionId} · ${session.student}` : "OnTrak Lab"}
        title={scenario.title}
        description={scenario.categoryLabel}
        actions={
          <Link href="/lab" className="text-sm font-semibold text-brand hover:underline">
            ← All machines
          </Link>
        }
      />
      <Flash flash={flash} error={error} />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={isUsable(session.state) ? "teal" : session.state === "error" ? "pink" : "amber"}>
          {session.state}
        </Badge>
        <Badge tone="neutral">{scenario.platform}</Badge>
        {session.workload !== "" ? <Badge tone="neutral">{session.workload}</Badge> : null}
        {remaining !== null ? (
          <span className="font-mono text-xs text-ink-faint">{formatClock(remaining)} left</span>
        ) : null}
        {runtime.mode === "demo" ? <Badge tone="sky">demo range</Badge> : null}
        {staff ? <Badge tone="amber">staff view</Badge> : null}
      </div>

      {session.error !== "" ? (
        <Alert tone="pink" title="The range reported a problem">
          {session.error}
        </Alert>
      ) : null}

      {!isUsable(session.state) && session.state !== "error" ? (
        <Card>
          <SessionPoller sessionId={sessionId} ready={status.ready} initial={status.progress} />
        </Card>
      ) : null}

      <SessionConsole
        sessionId={sessionId}
        available={url !== ""}
        address={address}
        reason={
          session.hostIp === ""
            ? "The machine has no address yet."
            : "No console gateway is configured for this deployment, or this guest has no remote desktop."
        }
      />

      <Card className="space-y-3">
        <SectionHeading title="The task" description={`${scenario.minutes} minutes' work · difficulty ${scenario.difficulty}/4`} />
        <p className="text-sm whitespace-pre-line text-ink-soft">{scenario.briefing}</p>
        <ul className="space-y-1 text-sm">
          {scenario.objectives.map((objective) => (
            <li key={objective.id} className="flex items-start gap-2 text-ink-soft">
              <span aria-hidden className="mt-1.5 size-1.5 rounded-full bg-brand" />
              <span>
                {objective.text}
                {objective.critical ? <span className="ml-1 text-xs font-semibold text-pink">critical</span> : null}
              </span>
            </li>
          ))}
        </ul>
        {hintsUpTo(scenario, session.hintLevel).length > 0 ? (
          <ol className="space-y-1 text-sm text-ink-soft">
            {hintsUpTo(scenario, session.hintLevel).map((hint, index) => (
              <li key={hint} className="rounded-xl2 bg-surface-muted px-3 py-2">
                <span className="font-semibold text-ink">Hint {index + 1}: </span>
                {hint}
              </li>
            ))}
          </ol>
        ) : null}
        {!handedIn && session.hintLevel < scenario.hints.length ? (
          <form action={revealLabHint}>
            <input type="hidden" name="sessionId" value={sessionId} />
            <Button type="submit" variant="secondary" size="sm">
              Reveal a hint ({session.hintLevel}/{scenario.hints.length})
            </Button>
          </form>
        ) : null}
      </Card>

      {report !== null ? (
        <Card className="space-y-3">
          <SectionHeading title="Your submitted result" description="A stored submission, not a preview." />
          <p className="text-sm text-ink-soft">{scoreReportSummaryLine(report)}</p>
          <p className="text-xs text-ink-faint">
            Machine {Math.round(report.machineScore)}%
            {report.ticketScore === null ? "" : ` · write-up ${Math.round(report.ticketScore)}%`}
            {report.ticketWeight > 0 ? ` (weighted ${report.ticketWeight}%)` : ""}
          </p>
        </Card>
      ) : null}

      {form !== null ? (
        <Card className="space-y-4">
          <SectionHeading
            title="The write-up"
            description="Marked with the machine when you hand the session in."
          />
          <WriteUpForm
            sessionId={sessionId}
            form={form}
            answers={answers}
            preview={submitted ?? preview?.grade ?? null}
            action={handedIn ? saveLabWriteUp : completeLabSession}
            disabled={handedIn}
          />
          {gradeRows.length > 0 ? (
            <ul className="space-y-1 text-xs">
              {gradeRows.map((row) => (
                <li key={String(row.field_id)} className="flex items-baseline gap-2">
                  <span className={row.passed === true ? "text-teal" : "text-pink"}>
                    {row.passed === true ? "✓" : "✗"}
                  </span>
                  <span className="text-ink-soft">{String(row.label)}</span>
                  {String(row.detail ?? "") !== "" ? (
                    <span className="text-ink-faint">{String(row.detail)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {preview?.grade != null && submitted === null ? (
            <p className="text-xs text-ink-faint">
              Preview only — {ticketGradeSummaryLine(preview.grade)}. Nothing is recorded until you
              hand the session in.
            </p>
          ) : null}
        </Card>
      ) : null}

      {!handedIn ? (
        <Card className="space-y-4">
          <SectionHeading title="Controls" description="Everything here acts on this machine only." />
          <div className="flex flex-wrap items-end gap-3">
            <form action={checkLabSession}>
              <input type="hidden" name="sessionId" value={sessionId} />
              <Button type="submit" disabled={!isUsable(session.state)}>
                Check my work
              </Button>
            </form>
            <form action={resetLabSession}>
              <input type="hidden" name="sessionId" value={sessionId} />
              <Button type="submit" variant="secondary">
                Reset the machine
              </Button>
            </form>
            <form action={extendLabSession} className="flex items-end gap-2">
              <input type="hidden" name="sessionId" value={sessionId} />
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-ink-soft">Extend</span>
                <select
                  name="minutes"
                  defaultValue="15"
                  className="rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
                >
                  {[15, 30, 60].map((minutes) => (
                    <option key={minutes} value={String(minutes)}>
                      {minutes} min
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" variant="secondary">
                Extend
              </Button>
            </form>
            <form action={setLabTimeLimit} className="flex items-end gap-2">
              <input type="hidden" name="sessionId" value={sessionId} />
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-ink-soft">Time limit</span>
                <select
                  name="minutes"
                  defaultValue={String(session.timeLimitMinutes)}
                  className="rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
                >
                  {runtime.settings.session.timeLimitChoices.map((minutes) => (
                    <option key={minutes} value={String(minutes)}>
                      {minutes} min
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" variant="secondary">
                Set
              </Button>
            </form>
          </div>
          <form action={endLabSession}>
            <input type="hidden" name="sessionId" value={sessionId} />
            <Button type="submit" variant="danger" size="sm">
              End the session and destroy the machine
            </Button>
          </form>
        </Card>
      ) : null}

      <Card className="space-y-3">
        <SectionHeading title="What happened here" description="The machine's own log, newest first." />
        {events.length === 0 ? (
          <EmptyState title="Nothing logged yet" />
        ) : (
          <ul className="space-y-1 text-xs">
            {events.map((event, index) => (
              <li key={`${event.createdAt}-${index}`} className="flex gap-3">
                <span className="w-40 shrink-0 font-mono text-ink-faint">
                  {formatDateTime(event.createdAt)}
                </span>
                <span className="font-semibold text-ink-soft">{event.kind}</span>
                <span className="text-ink-faint">{event.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {isUsable(session.state) && remaining === null ? (
        <p className="text-xs text-ink-faint">No deadline was recorded for this session.</p>
      ) : null}
      {isUsable(session.state) && remaining !== null && remaining < 300 ? (
        <ProgressBar value={(remaining / (session.timeLimitMinutes * 60 || 1)) * 100} tone="amber" label="Time left" />
      ) : null}
    </div>
  );
}

/** `mm:ss`/`h:mm:ss`, so a countdown is readable at a glance. */
function formatClock(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}
