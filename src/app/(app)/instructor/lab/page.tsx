import Link from "next/link";
import type { Metadata } from "next";

import { requireSession } from "@/lib/auth";
import { guardedRead } from "@/lib/lab/admin";
import { isLive, scoreReportSummaryLine, type LabSession } from "@/lib/lab/models";
import { consoleUrl, leaderboardRows } from "@/lib/lab/portal";
import { classResults } from "@/lib/lab/reporting";
import { labRuntimeForPage } from "@/lib/lab/service";
import { Alert, Badge, Card, EmptyState, SectionHeading, Stat } from "@/components/ui";
import { PageHeader } from "@/components/PageHeader";
import { formatDateTime } from "@/lib/cn";

export const metadata: Metadata = { title: "Lab — class view" };

/**
 * The instructor's view of the range: who is on a machine, whether it can start another
 * one, and what the class has produced.
 *
 * Two of the Python portal's hard-won behaviours are kept, and both are about rendering
 * when the host is unwell:
 *
 * **The page renders without the hypervisor.** `pool_status` and `template_status` shell
 * out to `incus`, and an instructor opening this page on a host that has not been prepared
 * yet — or whose machines live on a cluster — is an ordinary Tuesday. Each read is guarded
 * and its failure is reported as a line on the page; the template read was the unguarded
 * half in the Python, and it answered 500 and said nothing.
 *
 * **A refused console key is reported where an instructor is already looking.** The portal
 * signs every console link and never sees the gateway's answer, so a key mismatch leaves
 * every student with a blank iframe and nothing in either log. The check is one cached POST
 * (`guac.checkToken`), so it is asked here and its refusal is a sentence on this page.
 */
export default async function InstructorLabPage() {
  await requireSession();
  const { runtime, reason } = await labRuntimeForPage();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        eyebrow="OnTrak Lab"
        title="The class's machines"
        description="Every lab session on this deployment, and the range's own capacity."
        actions={
          <Link href="/instructor" className="text-sm font-semibold text-brand hover:underline">
            ← Control room
          </Link>
        }
      />
      {runtime === null ? (
        <Alert tone="amber" title="OnTrak Lab is not running on this deployment">
          {reason}
        </Alert>
      ) : (
        <Fleet runtime={runtime} />
      )}
    </div>
  );
}

async function Fleet({
  runtime,
}: {
  runtime: NonNullable<Awaited<ReturnType<typeof labRuntimeForPage>>["runtime"]>;
}) {
  const sessions = await runtime.store.listSessions({ limit: 200 });
  const scenarioTitles = new Map(runtime.repository.list().map((row) => [row.id, row.title]));

  const reports = new Map<number, string>();
  for (const session of sessions) {
    if (session.id === null) continue;
    const report = await runtime.store.latestReport(session.id);
    if (report !== null) reports.set(session.id, scoreReportSummaryLine(report));
  }

  // The class's marks, from the same gathering the two CSV exports use: one fan-out over
  // the roster (`reporting.ts`) and one rule for what "best" means (`leaderboardRows`), so
  // this page and a download cannot disagree.
  const results = await classResults(runtime);
  const submitted = results.filter((row) => row.createdAt !== "");

  // The two readings that shell out, and the console-key probe. Neither may stop the page.
  const problems: string[] = [];
  const pool = await guardedRead("warm pool", () => runtime.manager.poolStatus(), problems);
  const templates = await guardedRead("templates", () => runtime.manager.templateStatus(), problems);
  const unavailable = await guardedRead(
    "range availability",
    () => runtime.manager.unavailableScenarios(),
    problems,
  );
  const events = await runtime.store.recentEvents(40);

  const live = sessions.filter((session) => isLive(session.state));
  const handed = submitted.length;
  const passed = submitted.filter((row) => row.resolved).length;

  return (
    <>
      {runtime.mode === "demo" ? (
        <Alert tone="sky" title="Demo mode">
          The ported in-memory range: no hypervisor, no Windows media, no real machines.
        </Alert>
      ) : null}
      {problems.length > 0 ? (
        <Alert tone="amber" title="The range reported problems">
          <ul className="space-y-1">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Live machines" value={String(live.length)} />
        <Stat label="Sessions" value={String(sessions.length)} />
        <Stat label="Submitted" value={String(handed)} />
        <Stat label="Passed" value={String(passed)} />
      </div>

      <Card className="space-y-4">
        <SectionHeading
          title="Sessions"
          description="Newest first. A console opens only where the machine has an address."
          action={
            <div className="flex gap-3 text-xs font-semibold">
              <a href="/instructor/results.csv" className="text-brand hover:underline">
                results.csv
              </a>
              <a href="/instructor/lab/results-detail.csv" className="text-brand hover:underline">
                the blend, per result
              </a>
            </div>
          }
        />
        {sessions.length === 0 ? (
          <EmptyState title="No lab sessions yet" description="A student starting one appears here immediately." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Every lab session on this deployment</caption>
              <thead>
                <tr className="text-xs text-ink-faint">
                  <th scope="col" className="py-2 pr-4 font-semibold">Student</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Scenario</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">State</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Machine</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Result</th>
                  <th scope="col" className="py-2 font-semibold">Console</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    title={scenarioTitles.get(session.scenarioId) ?? session.scenarioId}
                    detail={
                      session.id !== null && reports.has(session.id)
                        ? (reports.get(session.id) ?? "")
                        : session.error !== ""
                          ? session.error
                          : ""
                    }
                    console={hasConsole(runtime, session)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3">
          <SectionHeading title="Capacity" description="Warm pool and templates, as the host reports them." />
          {pool.length === 0 && templates.length === 0 ? (
            <EmptyState title="Nothing to report" description="The pool is empty and no template is built yet." />
          ) : (
            <>
              {pool.length > 0 ? (
                <ul className="space-y-1 text-xs">
                  {pool.map((status) => (
                    <li key={status.label} className="flex gap-3">
                      <span className="font-mono text-ink-soft">{status.label}</span>
                      <span className="text-ink-faint">
                        {status.ready} ready / {status.target} wanted
                        {status.claimed > 0 ? ` · ${status.claimed} in use` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {templates.length > 0 ? (
                <ul className="space-y-1 text-xs">
                  {templates.map((status) => (
                    <li key={status.name} className="flex gap-3">
                      <span className="font-mono text-ink-soft">
                        {status.scenarioId}
                        {status.workload === "" ? "" : `@${status.workload}`}
                      </span>
                      <span className="text-ink-faint">
                        {status.ready
                          ? "built and usable"
                          : status.exists
                            ? "cloned, but not ready"
                            : "not built"}
                        {status.snapshot ? " · clean snapshot" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </Card>

        <Card className="space-y-3">
          <SectionHeading title="The class's marks" description="Best per student and scenario, final submissions only." />
          {submitted.length === 0 ? (
            <EmptyState title="Nothing handed in yet" />
          ) : (
            <ul className="space-y-1 text-xs">
              {leaderboardRows(results).map((row) => (
                <li key={`${row.student}-${row.scenarioId}`} className="flex gap-3">
                  <span className="w-40 shrink-0 truncate font-mono text-ink-soft">{row.student}</span>
                  <span className="flex-1 truncate">{scenarioTitles.get(row.scenarioId) ?? row.scenarioId}</span>
                  <span className="font-mono text-ink-faint">
                    {row.best}% · {row.attempts} attempt{row.attempts === 1 ? "" : "s"}
                  </span>
                  {row.solved ? <Badge tone="teal">passed</Badge> : <Badge tone="neutral">—</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {Object.keys(unavailable).length > 0 ? (
        <Card className="space-y-3">
          <SectionHeading title="Cannot start here" description="Refused before a session exists." />
          <ul className="space-y-1 text-xs">
            {Object.entries(unavailable).map(([id, why]) => (
              <li key={id}>
                <span className="font-mono text-ink-soft">{scenarioTitles.get(id) ?? id}</span>:{" "}
                <span className="text-ink-faint">{why}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="space-y-3">
        <SectionHeading title="Recent activity" description="The range's own log, newest first." />
        <ul className="space-y-1 text-xs">
          {events.map((event, index) => (
            <li key={`${event.createdAt}-${index}`} className="flex gap-3">
              <span className="w-40 shrink-0 font-mono text-ink-faint">{formatDateTime(event.createdAt)}</span>
              <span className="font-semibold text-ink-soft">{event.kind}</span>
              <span className="text-ink-faint">{event.detail}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

/*
 * The guarded host reads this page needed first — `poolStatus`, `templateStatus` and
 * `unavailableScenarios` all shell out, and a host that has not been prepared yet is a normal
 * place for an instructor to open it — now live in `@/lib/lab/admin` as `guardedRead`, so the
 * admin panel and this page cannot drift into two versions of "a report must not raise".
 */

/** Whether a machine has a console at all: an address *and* a gateway key. */
function hasConsole(
  runtime: NonNullable<Awaited<ReturnType<typeof labRuntimeForPage>>["runtime"]>,
  session: LabSession,
): boolean {
  try {
    return consoleUrl(runtime.settings, session, runtime.repository.get(session.scenarioId)) !== "";
  } catch {
    return false;
  }
}

function SessionRow({
  session,
  title,
  detail,
  console: hasConsoleLink,
}: {
  session: LabSession;
  title: string;
  detail: string;
  console: boolean;
}) {
  return (
    <tr className="border-t border-line">
      <td className="py-2 pr-4 font-mono text-xs text-ink-soft">{session.student}</td>
      <td className="py-2 pr-4">
        <Link href={`/lab/sessions/${String(session.id)}`} className="font-semibold text-brand hover:underline">
          {title}
        </Link>
      </td>
      <td className="py-2 pr-4">
        <Badge tone={isLive(session.state) ? "teal" : "neutral"}>{session.state}</Badge>
      </td>
      <td className="py-2 pr-4 font-mono text-xs text-ink-faint">{session.hostIp || "—"}</td>
      <td className="py-2 pr-4 text-xs text-ink-soft">{detail || "—"}</td>
      <td className="py-2 text-xs">
        {hasConsoleLink ? (
          <a
            href={`/lab/sessions/${String(session.id)}/console`}
            className="font-semibold text-brand hover:underline"
          >
            Open
          </a>
        ) : (
          <span className="text-ink-faint">—</span>
        )}
      </td>
    </tr>
  );
}
