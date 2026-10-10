import Link from "next/link";
import type { Metadata } from "next";

import { requireLabStaff } from "@/lib/lab-admin-access";
import { scenarioTitles, scenariosWithTicket } from "@/lib/lab/admin";
import { labRuntimeForPage, type LabRuntime } from "@/lib/lab/service";
import { LabAdminPanel, LabOff } from "@/components/lab/LabAdminPanel";
import { Badge, Card, EmptyState, SectionHeading, Stat } from "@/components/ui";
import { formatDateTime } from "@/lib/cn";
import { formatFixed } from "@/lib/lab/scoring";

export const metadata: Metadata = { title: "Lab — tickets" };

/**
 * The write-ups students handed in, and how each was marked.
 *
 * The list is the store's own ticket rows (`store.listTickets`) rather than the sessions, so a
 * session whose write-up was never handed in is not on this page — an unsubmitted draft is not
 * a grade (`store.ts`: "a draft is not a grade"), and a marking record that listed drafts would
 * be the leak that split exists to prevent. The statistics are the store's too, so this page
 * and the overview cannot disagree about how many tickets there are.
 *
 * The scenario half of the same question — which scenarios *declare* a form — is read from the
 * repository, which is what makes "12 of 14 scenarios ask for a write-up" a fact rather than a
 * count of whatever a class happened to hand in.
 */
export default async function LabAdminTicketsPage() {
  await requireLabStaff();
  const { runtime, reason } = await labRuntimeForPage();

  return (
    <LabAdminPanel
      section="tickets"
      title="Tickets"
      description="Every write-up that was handed in, with the mark its rubric produced."
    >
      {runtime === null ? <LabOff reason={reason} /> : <Tickets runtime={runtime} />}
    </LabAdminPanel>
  );
}

async function Tickets({ runtime }: { runtime: LabRuntime }) {
  const [rows, stats] = await Promise.all([
    runtime.store.listTickets(200),
    runtime.store.countTickets(),
  ]);
  const withTicket = scenariosWithTicket(runtime.repository);
  const titles = scenarioTitles(runtime.repository);
  const scenarioCount = runtime.repository.list().length;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Marked tickets" value={String(stats.count)} />
        <Stat label="Handed in" value={String(stats.submitted)} tone="teal" />
        <Stat
          label="Average mark"
          value={stats.count === 0 ? "—" : `${formatFixed(stats.average, 1)}%`}
        />
        <Stat label="Scenarios asking for one" value={`${withTicket.length} / ${scenarioCount}`} />
      </div>

      <Card className="space-y-3">
        <SectionHeading
          title="The marking record"
          description="Newest first. A draft in progress is never a row here."
          action={
            <Link href="/lab/admin" className="text-xs font-semibold text-brand hover:underline">
              ← Overview
            </Link>
          }
        />
        {rows.length === 0 ? (
          <EmptyState
            title="No write-ups handed in yet"
            description="A student completing a session with a ticket form appears here with their mark."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Every marked ticket on this deployment</caption>
              <thead>
                <tr className="text-xs text-ink-faint">
                  <th scope="col" className="py-2 pr-4 font-semibold">Student</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Scenario</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Mark</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">State</th>
                  <th scope="col" className="py-2 font-semibold">When</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t border-line">
                    <td className="py-2 pr-4 font-mono text-xs text-ink-soft">{row.student}</td>
                    <td className="py-2 pr-4">
                      <Link
                        href={`/lab/admin/tickets/${String(row.sessionId)}`}
                        className="font-semibold text-brand hover:underline"
                      >
                        {titles.get(row.scenarioId) ?? row.scenarioId}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {row.submitted ? `${formatFixed(row.score, 1)}%` : "—"}
                    </td>
                    <td className="py-2 pr-4">
                      {row.submitted ? <Badge tone="teal">handed in</Badge> : <Badge tone="neutral">draft</Badge>}
                    </td>
                    <td className="py-2 font-mono text-xs text-ink-faint">
                      {formatDateTime(row.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="space-y-3">
        <SectionHeading
          title="Scenarios that ask for a write-up"
          description="The rest are graded on machine state alone."
        />
        {withTicket.length === 0 ? (
          <EmptyState title="No scenario declares a ticket form" />
        ) : (
          <ul className="space-y-1 text-xs">
            {withTicket.map((scenario) => (
              <li key={scenario.id} className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-ink-soft">{scenario.id}</span>
                <span className="text-ink">{scenario.title}</span>
                <span className="text-ink-faint">· {scenario.categoryLabel}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
