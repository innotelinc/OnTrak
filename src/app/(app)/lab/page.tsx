import Link from "next/link";
import type { Metadata } from "next";

import { isStaff, requireSession } from "@/lib/auth";
import { startLabSession } from "@/app/actions/lab";
import { isLive, scoreReportSummaryLine, type LabSession } from "@/lib/lab/models";
import { catalogueByCategory, workloadGroups } from "@/lib/lab/portal";
import { labRuntimeForPage } from "@/lib/lab/service";
import { Alert, Badge, Button, Card, EmptyState, SectionHeading } from "@/components/ui";
import { PageHeader, Flash } from "@/components/PageHeader";

export const metadata: Metadata = { title: "OnTrak Lab" };

/**
 * The lab's dashboard: everything a student needs to start a machine, and nothing else.
 *
 * Three things are deliberately on this page that the Python's template made easy to get
 * wrong, and each is a rule rather than a layout choice:
 *
 * **A scenario this range cannot run says so, before a session exists.** The reasons come
 * from the manager's own availability check, which is the same call `startLabSession` makes
 * — so a scenario that cannot start here is refused at the form *and* on the POST, rather
 * than being offered and then failing after it has burned a slot.
 *
 * **A lab that is off is off, with the reason.** Unconfigured, misconfigured, or running
 * against a peer deployment: the page says which, from `labDoor`/the runtime's own
 * refusal, instead of drawing a dashboard over a service that is not there.
 *
 * **Demo mode is labelled.** A deployment running the ported in-memory range must not be
 * mistaken for one with machines: the banner says so, and the sessions are labelled with
 * the mode they really ran in.
 */
export default async function LabHome({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const { flash, error } = await searchParams;
  const user = await requireSession();
  const { runtime, reason } = await labRuntimeForPage();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        eyebrow="OnTrak Lab"
        title="Real machines, real faults"
        description="Stand up a machine, break nothing on your own laptop, and hand in the write-up."
        actions={
          <>
            <Link href="/lab/lessons" className="text-sm font-semibold text-brand hover:underline">
              Lessons
            </Link>
            {isStaff(user) ? (
              <Link href="/lab/admin" className="text-sm font-semibold text-brand hover:underline">
                Admin
              </Link>
            ) : null}
            <Link href="/student" className="text-sm font-semibold text-brand hover:underline">
              Simulated scenarios →
            </Link>
          </>
        }
      />
      <Flash flash={flash} error={error} />

      {runtime === null ? (
        <Alert tone="amber" title="OnTrak Lab is not running on this deployment">
          {reason}
        </Alert>
      ) : (
        <LabBody user={{ email: user.email, name: user.name }} runtime={runtime} />
      )}
    </div>
  );
}

async function LabBody({
  user,
  runtime,
}: {
  user: { email: string; name: string };
  runtime: NonNullable<Awaited<ReturnType<typeof labRuntimeForPage>>["runtime"]>;
}) {
  const student = user.email.trim().toLowerCase();
  const [sessions, unavailable] = await Promise.all([
    runtime.store.listSessions({ student, limit: 25 }),
    runtime.manager.unavailableScenarios(),
  ]);

  const reports = new Map<number, string>();
  for (const session of sessions) {
    if (session.id === null) continue;
    const report = await runtime.store.latestReport(session.id);
    if (report !== null) reports.set(session.id, scoreReportSummaryLine(report));
  }

  const open = sessions.filter((session) => isLive(session.state));
  const past = sessions.filter((session) => !isLive(session.state));
  const results = await runtime.store.resultsForStudent(student);
  const groups = catalogueByCategory(runtime.repository);
  const workloads = workloadGroups(runtime.catalog);
  const scenarioTitles = new Map(
    runtime.repository.list().map((scenario) => [scenario.id, scenario.title]),
  );

  return (
    <>
      {runtime.mode === "demo" ? (
        <Alert tone="sky" title="Demo mode">
          This deployment runs the lab&apos;s ported in-memory range: a whole class works
          end to end, no hypervisor and no Windows media. No real machine is stood up.
        </Alert>
      ) : null}
      {runtime.mode === "host" && !runtime.hypervisor ? (
        <Alert tone="amber" title="No hypervisor on this host">
          The lab is running, but <code className="font-mono">incus</code> is not available,
          so no machine can start. An operator can check the host with the CLI&apos;s
          <code className="font-mono"> doctor</code> command.
        </Alert>
      ) : null}

      <Card className="space-y-4">
        <SectionHeading
          title="Start a machine"
          description={`${groups.reduce((sum, group) => sum + group.scenarios.length, 0)} scenarios on this range`}
        />
        <form action={startLabSession} className="grid gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-sm font-semibold text-ink">Scenario</span>
            <select
              name="scenarioId"
              className="w-full rounded-xl2 border border-line bg-surface px-3.5 py-2.5 text-sm text-ink"
              defaultValue={runtime.settings.selection.autoAssign ? "auto" : ""}
            >
              {runtime.settings.selection.autoAssign ? (
                <option value="auto">Surprise me — the range picks</option>
              ) : (
                <option value="">Choose a scenario…</option>
              )}
              {groups.map((group) => (
                <optgroup key={group.category} label={group.label}>
                  {group.scenarios.map((scenario) => (
                    <option key={String(scenario.id)} value={String(scenario.id)}>
                      {String(scenario.title)}
                      {unavailable[String(scenario.id)] ? " — not available here" : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-ink">
              Platform <span className="font-normal text-ink-faint">(optional)</span>
            </span>
            <select
              name="workload"
              className="w-full rounded-xl2 border border-line bg-surface px-3.5 py-2.5 text-sm text-ink"
            >
              <option value="">The scenario&apos;s own default</option>
              {workloads.map((group) => (
                <optgroup key={group.id} label={group.label}>
                  {group.entries.map((entry) => (
                    <option key={String(entry.id)} value={String(entry.id)}>
                      {String(entry.name)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-ink">Time limit</span>
            <select
              name="timeLimit"
              className="w-full rounded-xl2 border border-line bg-surface px-3.5 py-2.5 text-sm text-ink"
              defaultValue={String(runtime.settings.session.timeLimitChoices[0] ?? "")}
            >
              {runtime.settings.session.timeLimitChoices.map((minutes) => (
                <option key={minutes} value={String(minutes)}>
                  {minutes} minutes
                </option>
              ))}
            </select>
          </label>

          <div className="sm:col-span-2">
            <Button type="submit">Start a machine</Button>
          </div>
        </form>

        {Object.keys(unavailable).length > 0 ? (
          <details className="text-xs text-ink-faint">
            <summary className="cursor-pointer font-semibold text-ink-soft">
              {Object.keys(unavailable).length} scenario
              {Object.keys(unavailable).length === 1 ? "" : "s"} this range cannot start
            </summary>
            <ul className="mt-2 space-y-1">
              {Object.entries(unavailable).map(([id, why]) => (
                <li key={id}>
                  <span className="font-mono">{id}</span>: {why}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>

      <Card className="space-y-4">
        <SectionHeading title="My machines" description="A session is a machine; one live per scenario." />
        {open.length === 0 ? (
          <EmptyState title="No machine running" description="Start one above and it appears here." />
        ) : (
          <ul className="space-y-2">
            {open.map((session) => (
              <SessionRow key={session.id} session={session} title={scenarioTitles.get(session.scenarioId) ?? session.scenarioId} detail={reportDetail(session, reports)} />
            ))}
          </ul>
        )}
      </Card>

      {past.length > 0 ? (
        <Card className="space-y-4">
          <SectionHeading title="Finished" description="Closed machines, and the marks they produced." />
          <ul className="space-y-2">
            {past.map((session) => (
              <SessionRow key={session.id} session={session} title={scenarioTitles.get(session.scenarioId) ?? session.scenarioId} detail={reportDetail(session, reports)} />
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="space-y-4">
        <SectionHeading
          title="My results"
          description="Final submissions only: a check you run is a preview and is never recorded."
          action={
            <Link href="/student/results" className="text-xs font-semibold text-brand hover:underline">
              All results →
            </Link>
          }
        />
        {results.length === 0 ? (
          <EmptyState title="Nothing submitted yet" description="Hand a session in and its grade appears here." />
        ) : (
          <ul className="space-y-1 text-sm">
            {results.slice(-10).reverse().map((report, index) => (
              <li key={`${report.sessionId}-${index}`} className="flex items-baseline justify-between gap-3">
                <span className="text-ink-soft">
                  {scenarioTitles.get(report.scenarioId) ?? report.scenarioId}
                </span>
                <span className="font-mono text-xs text-ink-faint">{scoreReportSummaryLine(report)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function reportDetail(session: LabSession, reports: Map<number, string>): string {
  if (session.id !== null && reports.has(session.id)) return reports.get(session.id) ?? "";
  if (session.error !== "") return session.error;
  return session.state;
}

function SessionRow({
  session,
  title,
  detail,
}: {
  session: LabSession;
  title: string;
  detail: string;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl2 border border-line px-4 py-3">
      <div>
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="text-xs text-ink-faint">
          {detail}
          {session.hintLevel > 0 ? ` · ${session.hintLevel} hint${session.hintLevel === 1 ? "" : "s"} used` : ""}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Badge tone={isLive(session.state) ? "teal" : "neutral"}>{session.state}</Badge>
        <Link
          href={`/lab/sessions/${String(session.id)}`}
          className="text-sm font-semibold text-brand hover:underline"
        >
          Open
        </Link>
      </div>
    </li>
  );
}
