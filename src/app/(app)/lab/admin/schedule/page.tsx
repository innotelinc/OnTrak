import type { Metadata } from "next";

import { requireLabStaff } from "@/lib/lab-admin-access";
import { guardedRead, scheduleView } from "@/lib/lab/admin";
import { scheduleToSchedule } from "@/lib/lab/config";
import { labRuntimeForPage, type LabRuntime } from "@/lib/lab/service";
import { LabAdminPanel, LabOff } from "@/components/lab/LabAdminPanel";
import { Alert, Badge, Card, EmptyState, SectionHeading, Stat } from "@/components/ui";

export const metadata: Metadata = { title: "Lab — schedule" };

/**
 * The prewarm and teardown windows, at this instant.
 *
 * The Python's `/admin/schedule` was a view *plus* a `POST /admin/schedule/tick` that executed
 * the window's actions. The port keeps the view and leaves the execution to the CLI
 * (`npm run lab schedule tick` prints what the window asks for; `npm run lab reap --loop`
 * performs the range's maintenance), for the same reason the overview carries no maintenance
 * form: a panel is a report rather than a remote control, and every operation that shells out
 * to `incus` belongs where the machines live (see `lab-port.md` §3/C4). What the page owes an
 * operator in exchange is the *plan* — the actions a tick would run, computed by the
 * schedule's own pure code at the current instant — so "what would 08:50 do" is answerable
 * here without executing anything.
 *
 * The pool reading shells out and is guarded; a host that has not been prepared renders with a
 * line saying so.
 */
export default async function LabAdminSchedulePage() {
  await requireLabStaff();
  const { runtime, reason } = await labRuntimeForPage();

  return (
    <LabAdminPanel
      section="schedule"
      title="Schedule"
      description="When the range prewarms, when it drains, and what it would do right now."
    >
      {runtime === null ? <LabOff reason={reason} /> : <Schedule runtime={runtime} />}
    </LabAdminPanel>
  );
}

async function Schedule({ runtime }: { runtime: LabRuntime }) {
  const problems: string[] = [];
  const pool = await guardedRead("warm pool", () => runtime.manager.poolStatus(), problems);
  const view = scheduleView(scheduleToSchedule(runtime.settings.schedule), new Date());

  return (
    <>
      {problems.length > 0 ? (
        <Alert tone="amber" title="The host did not answer">
          <ul className="space-y-1">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Schedule"
          value={view.enabled ? "enabled" : "disabled"}
          tone={view.enabled ? "teal" : "neutral"}
        />
        <Stat label="Right now" value={view.enabled ? view.phase : "—"} />
        <Stat label="Windows" value={String(view.windows.length)} />
      </div>

      {!view.enabled ? (
        <Alert tone="amber" title="The schedule is switched off">
          Machines are still started on request; nothing is prewarmed and nothing is drained on a
          timetable. Set <code className="font-mono">ONTRAK_SCHEDULE__ENABLED=1</code> and the
          windows below take effect.
        </Alert>
      ) : null}

      <Card className="space-y-3">
        <SectionHeading title="Windows" description="Prewarm in the lead-in, drain once the window closes." />
        {view.windows.length === 0 ? (
          <EmptyState title="No windows configured" description="Every machine is started on request." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">The configured prewarm and teardown windows</caption>
              <thead>
                <tr className="text-xs text-ink-faint">
                  <th scope="col" className="py-2 pr-4 font-semibold">Window</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Days</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Open</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Lead-in</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Target</th>
                  <th scope="col" className="py-2 font-semibold">Scenarios</th>
                </tr>
              </thead>
              <tbody>
                {view.windows.map((window, index) => (
                  <tr key={`${window.label}-${index}`} className="border-t border-line">
                    <td className="py-2 pr-4 font-semibold text-ink">{window.label}</td>
                    <td className="py-2 pr-4 text-xs text-ink-soft">{window.days.join(", ")}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-ink-soft">
                      {window.start}–{window.end}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-ink-faint">
                      {window.prewarmMinutes} min
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-ink-faint">{window.target}</td>
                    <td className="py-2 text-xs text-ink-faint">
                      {window.scenarios.length === 0 ? "every scenario" : window.scenarios.join(", ")}
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
          title="What a tick would do now"
          description="The schedule's own decision at this instant, without executing it."
        />
        {view.planned.length === 0 ? (
          <EmptyState
            title="Nothing to do"
            description="No window is expecting machines right now, or the pool already meets its target."
          />
        ) : (
          <ul className="space-y-2 text-xs">
            {view.planned.map((action, index) => (
              <li key={index} className="flex flex-wrap items-baseline gap-2">
                <Badge tone={action.kind === "prewarm" ? "teal" : "amber"}>
                  {String(action.kind)}
                </Badge>
                <span className="font-mono text-ink-soft">
                  {String(action.scenario_id ?? action.scenarioId ?? "—")}
                </span>
                <span className="text-ink-faint">
                  {action.count === undefined ? "" : `×${String(action.count)} · `}
                  {String(action.reason ?? "")}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-ink-faint">
          Run it where the machines live: <code className="font-mono">npm run lab schedule tick</code>{" "}
          prints this plan, and <code className="font-mono">npm run lab reap --loop</code> performs the
          range&apos;s maintenance.
        </p>
      </Card>

      <Card className="space-y-3">
        <SectionHeading title="Pool now" description="Handout-ready machines per scenario." />
        {pool.length === 0 ? (
          <EmptyState title="The pool is empty" />
        ) : (
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
        )}
      </Card>
    </>
  );
}
