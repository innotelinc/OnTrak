import Link from "next/link";
import type { Metadata } from "next";

import { requireLabStaff } from "@/lib/lab-admin-access";
import { auditKindOptions } from "@/lib/lab/admin";
import { labRuntimeForPage, type LabRuntime } from "@/lib/lab/service";
import { LabAdminPanel, LabOff } from "@/components/lab/LabAdminPanel";
import { Button, Card, EmptyState, Input, SectionHeading, Select, Stat } from "@/components/ui";
import { formatDateTime } from "@/lib/cn";

export const metadata: Metadata = { title: "Lab — audit" };

/** The most events one page will show, and the least — the Python's own clamp. */
const MIN_LIMIT = 1;
const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 300;

/**
 * Everything the control plane did, in order.
 *
 * Two things this page is careful about, and both are the reason the read lives on the store.
 *
 * **The filter is applied by the store, not by the page.** `store.listEvents({ kind, limit })`
 * returns *that kind's* newest N; a page-side filter over the newest N would show a kind's
 * events from an arbitrary window, which is a different claim on any deployment whose log is
 * bigger than one page. The kinds the filter offers come from `store.eventKinds()` — the
 * distinct kinds actually present — rather than from a hand-kept list that would go stale the
 * first time the control plane logs something new.
 *
 * **The trail is read-only, and that is enforced by having no verb.** `store.ts` has no
 * `updateEvent` and no `deleteEvent`, so there is nothing here to draw: an audit page that
 * offered a correction would not be an audit page.
 *
 * The filter is a plain `GET` form, so a filtered view is a URL an operator can bookmark or
 * paste into a ticket, which is what the Python's query parameters already were.
 */
export default async function LabAdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; limit?: string }>;
}) {
  await requireLabStaff();
  const { kind, limit } = await searchParams;
  const { runtime, reason } = await labRuntimeForPage();

  return (
    <LabAdminPanel
      section="audit"
      title="Audit"
      description="Every event the control plane wrote, newest first."
    >
      {runtime === null ? <LabOff reason={reason} /> : <Audit runtime={runtime} kind={kind} limit={limit} />}
    </LabAdminPanel>
  );
}

async function Audit({
  runtime,
  kind,
  limit,
}: {
  runtime: LabRuntime;
  kind: string | undefined;
  limit: string | undefined;
}) {
  const kinds = await runtime.store.eventKinds();
  const selected = kind !== undefined && kinds.includes(kind) ? kind : "";
  const requested = Number(limit ?? DEFAULT_LIMIT);
  const capped = Number.isFinite(requested)
    ? Math.max(MIN_LIMIT, Math.min(Math.trunc(requested), MAX_LIMIT))
    : DEFAULT_LIMIT;

  const [events, total] = await Promise.all([
    runtime.store.listEvents({ kind: selected || null, limit: capped }),
    runtime.store.countEvents(),
  ]);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Events in the log" value={String(total)} />
        <Stat label="Kinds" value={String(kinds.length)} />
        <Stat label="Showing" value={String(events.length)} />
      </div>

      <Card className="space-y-3">
        <SectionHeading title="Filter" description="By kind, and how many at most." />
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-ink">Kind</span>
            <Select name="kind" defaultValue={selected}>
              {auditKindOptions(kinds).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-ink">Show at most</span>
            <Input
              name="limit"
              type="number"
              min={MIN_LIMIT}
              max={MAX_LIMIT}
              defaultValue={String(capped)}
              className="w-28"
            />
          </label>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          {selected !== "" ? (
            <Link href="/lab/admin/audit" className="text-xs font-semibold text-brand hover:underline">
              Clear
            </Link>
          ) : null}
        </form>
      </Card>

      <Card className="space-y-3">
        <SectionHeading
          title={selected === "" ? "Every kind" : `Kind: ${selected}`}
          description="Newest first. The log is append-only; nothing here can be edited or removed."
        />
        {events.length === 0 ? (
          <EmptyState
            title="Nothing logged"
            description={
              selected === ""
                ? "The control plane has not written an event yet."
                : `No event of kind “${selected}” has been written.`
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">The lab&apos;s audit trail, newest first</caption>
              <thead>
                <tr className="text-xs text-ink-faint">
                  <th scope="col" className="py-2 pr-4 font-semibold">When</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Kind</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Session</th>
                  <th scope="col" className="py-2 font-semibold">Detail</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} className="border-t border-line align-top">
                    <td className="py-2 pr-4 font-mono text-xs text-ink-faint">
                      {formatDateTime(event.createdAt)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs font-semibold text-ink-soft">
                      {event.kind}
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      {event.sessionId === null ? (
                        <span className="text-ink-faint">—</span>
                      ) : (
                        <Link
                          href={`/lab/sessions/${String(event.sessionId)}`}
                          className="font-mono text-brand hover:underline"
                        >
                          #{event.sessionId}
                        </Link>
                      )}
                    </td>
                    <td className="py-2 text-xs text-ink-soft">{event.detail || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
