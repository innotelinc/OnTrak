import Link from "next/link";
import type { Metadata } from "next";

import { prisma } from "@/lib/db";
import { requireLabStaff } from "@/lib/lab-admin-access";
import {
  catalogFacts,
  guardedRead,
  liveCount,
  readyPool,
  readyTemplates,
  scheduleView,
  settingsSummary,
  stateCounts,
} from "@/lib/lab/admin";
import { scheduleToSchedule } from "@/lib/lab/config";
import { scenarioFiles } from "@/lib/lab/dataset";
import { scoreReportSummaryLine } from "@/lib/lab/models";
import { labRuntimeForPage, type LabRuntime } from "@/lib/lab/service";
import { LabAdminPanel, LabOff } from "@/components/lab/LabAdminPanel";
import { Alert, Badge, Card, EmptyState, SectionHeading, Stat } from "@/components/ui";
import { formatDateTime } from "@/lib/cn";

export const metadata: Metadata = { title: "Lab — overview" };

/**
 * The panel's landing page: the estate at a glance, and the range's own health.
 *
 * This is `admin_overview` from `admin.py`, with one job changed on purpose. The Python page
 * also carried a maintenance form (reap, refill, drain, build templates, validate). Those are
 * operations against a live hypervisor, and the port has them where they belong: the CLI
 * (`npm run lab`), which an operator runs where the machines live, and the schedule tick,
 * which is its own page's action. A browser button that shells out to `incus` on a web worker
 * is the shape the port rejected everywhere else (see `lab-port.md` §3/C4), and a panel is a
 * report rather than a remote control.
 *
 * The readings that do shell out — the warm pool and the templates — are guarded: a host that
 * has not been prepared is an ordinary Tuesday, and the page reports it as a line.
 */
export default async function LabAdminOverviewPage() {
  await requireLabStaff();
  const { runtime, reason } = await labRuntimeForPage();

  return (
    <LabAdminPanel
      section="overview"
      title="The estate"
      description="Every session, every account, and whether this range can start a machine."
    >
      {runtime === null ? <LabOff reason={reason} /> : <Estate runtime={runtime} />}
    </LabAdminPanel>
  );
}

async function Estate({ runtime }: { runtime: LabRuntime }) {
  const [sessions, tickets, events, eventCount, accounts] = await Promise.all([
    runtime.store.listSessions({ limit: 500 }),
    runtime.store.countTickets(),
    runtime.store.recentEvents(15),
    runtime.store.countEvents(),
    prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
  ]);

  // The reads that shell out, collected instead of thrown (the Python's `safe`).
  const problems: string[] = [];
  const pool = await guardedRead("warm pool", () => runtime.manager.poolStatus(), problems);
  const templates = await guardedRead("templates", () => runtime.manager.templateStatus(), problems);

  const counts = stateCounts(sessions);
  const live = liveCount(counts);
  const schedule = scheduleView(scheduleToSchedule(runtime.settings.schedule), new Date());
  const settings = settingsSummary(runtime.settings);
  // `files` is passed as well as the catalogue and the lessons, because without it the
  // validator can only check the record and says so once per scenario — "no scenario files
  // were supplied, so the setup/check contract was not checked". The scripts are the half a
  // student is graded by, so the health panel reads them too (the Python's repository carried
  // its own directory and did the same).
  const scenarios = runtime.repository.list();
  const scenarioProblems = runtime.repository.validate(null, {
    files: scenarioFiles(scenarios),
    catalog: catalogFacts(runtime.catalog),
    lessons: runtime.lessons,
  });
  const lessonProblems = runtime.lessons.validate();
  const accountCount = accounts.reduce((total, row) => total + row._count._all, 0);
  const titles = new Map(runtime.repository.list().map((scenario) => [scenario.id, scenario.title]));

  return (
    <>
      {runtime.mode === "demo" ? (
        <Alert tone="sky" title="Demo mode">
          The ported in-memory range: a whole class works end to end with no hypervisor and no
          Windows media, and no figure here describes a real machine.
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Live machines" value={String(live)} tone="teal" />
        <Stat label="Sessions" value={String(sessions.length)} />
        <Stat label="Accounts" value={String(accountCount)} />
        <Stat label="Tickets" value={String(tickets.count)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3">
          <SectionHeading title="Sessions by state" description="Every state, including the empty ones." />
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
            {Object.entries(counts).map(([state, count]) => (
              <li key={state} className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-ink-soft">{state}</span>
                <span className="font-semibold text-ink">{count}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="space-y-3">
          <SectionHeading
            title="Capacity"
            description="Warm pool and templates, as the host reports them."
            action={
              <Link href="/instructor/lab" className="text-xs font-semibold text-brand hover:underline">
                Class view →
              </Link>
            }
          />
          <ul className="space-y-1 text-xs">
            <li className="flex justify-between gap-3">
              <span className="text-ink-faint">Machines ready to hand out</span>
              <span className="font-semibold text-ink">
                {readyPool(pool)} / {pool.reduce((total, status) => total + status.target, 0)}
              </span>
            </li>
            <li className="flex justify-between gap-3">
              <span className="text-ink-faint">Templates built</span>
              <span className="font-semibold text-ink">
                {readyTemplates(templates)} / {templates.length}
              </span>
            </li>
            <li className="flex justify-between gap-3">
              <span className="text-ink-faint">Catalogue entries</span>
              <span className="font-semibold text-ink">{runtime.catalog.load().size}</span>
            </li>
            <li className="flex justify-between gap-3">
              <span className="text-ink-faint">Scenarios · lessons</span>
              <span className="font-semibold text-ink">
                {runtime.repository.list().length} · {runtime.lessons.list().length}
              </span>
            </li>
          </ul>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3">
          <SectionHeading title="Settings" description="What the range will do without being asked again." />
          <ul className="space-y-1 text-xs">
            <li className="flex justify-between gap-3">
              <span className="text-ink-faint">Session lifetime</span>
              <span className="font-mono text-ink-soft">{settings.ttlMinutes} min</span>
            </li>
            <li className="flex justify-between gap-3">
              <span className="text-ink-faint">Warm pool</span>
              <span className="text-ink-soft">
                {settings.poolEnabled ? "on" : "off"} · target {settings.defaultTarget} · max {settings.maxTotal}
              </span>
            </li>
            <li className="flex justify-between gap-3">
              <span className="text-ink-faint">Progress</span>
              <span className="text-ink-soft">
                {settings.persistProgress ? "kept between attempts" : "results only"}
              </span>
            </li>
            <li className="flex justify-between gap-3">
              <span className="text-ink-faint">On Complete &amp; End</span>
              <span className="text-ink-soft">
                {settings.destroyOnComplete ? "destroy the machine" : "leave it running"}
              </span>
            </li>
            <li className="flex justify-between gap-3">
              <span className="text-ink-faint">Schedule now</span>
              <span className="text-ink-soft">
                {schedule.enabled ? schedule.phase : "disabled"}
              </span>
            </li>
          </ul>
          <Link href="/lab/admin/schedule" className="text-xs font-semibold text-brand hover:underline">
            The windows →
          </Link>
        </Card>

        <Card className="space-y-3">
          <SectionHeading
            title="Catalogue health"
            description="A scenario that would fail a student is a problem before a class, not during one."
          />
          {scenarioProblems.length === 0 && lessonProblems.length === 0 ? (
            <p className="text-xs text-teal">
              All {runtime.repository.list().length} scenarios and {runtime.lessons.list().length} lessons
              validate.
            </p>
          ) : (
            <ul className="space-y-1 text-xs">
              {[...scenarioProblems, ...lessonProblems].slice(0, 12).map((problem) => (
                <li key={problem} className="text-ink-soft">
                  {problem}
                </li>
              ))}
              {scenarioProblems.length + lessonProblems.length > 12 ? (
                <li className="text-ink-faint">
                  … and {scenarioProblems.length + lessonProblems.length - 12} more.
                </li>
              ) : null}
            </ul>
          )}
        </Card>
      </div>

      <Card className="space-y-3">
        <SectionHeading
          title="Recent sessions"
          description="Newest first, from the same store every other page reads."
        />
        {sessions.length === 0 ? (
          <EmptyState title="No sessions yet" description="A student starting one appears here immediately." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">The newest lab sessions on this deployment</caption>
              <thead>
                <tr className="text-xs text-ink-faint">
                  <th scope="col" className="py-2 pr-4 font-semibold">Student</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Scenario</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">State</th>
                  <th scope="col" className="py-2 font-semibold">Machine</th>
                </tr>
              </thead>
              <tbody>
                {sessions.slice(0, 12).map((session) => (
                  <tr key={session.id} className="border-t border-line">
                    <td className="py-2 pr-4 font-mono text-xs text-ink-soft">{session.student}</td>
                    <td className="py-2 pr-4">
                      <Link
                        href={`/lab/sessions/${String(session.id)}`}
                        className="font-semibold text-brand hover:underline"
                      >
                        {titles.get(session.scenarioId) ?? session.scenarioId}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">
                      <Badge tone="neutral">{session.state}</Badge>
                    </td>
                    <td className="py-2 font-mono text-xs text-ink-faint">{session.hostIp || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="space-y-3">
        <SectionHeading
          title="Recent activity"
          description={`${eventCount} events in the log, newest 15 shown.`}
          action={
            <Link href="/lab/admin/audit" className="text-xs font-semibold text-brand hover:underline">
              The whole trail →
            </Link>
          }
        />
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
    </>
  );
}
