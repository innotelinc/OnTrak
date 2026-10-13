import { redirect } from "next/navigation";

import { requireActor } from "../../../lib/session";
import { actorHasPermission } from "../../../lib/access-rules";
import {
  commsTemplateServicesFor,
  complianceServicesFor,
  incidentDocsServicesFor,
  incidentServicesFor,
} from "../../../lib/db";
import {
  INCIDENT_IMPACTS,
  INCIDENT_SEVERITIES,
  INCIDENT_URGENCIES,
  isIncidentClosed,
  severityRank,
} from "../../../lib/incident-rules";
import { notificationState } from "../../../lib/regulatory-rules";
import { actionState } from "../../../lib/review-rules";
import { IncidentRow, unassignedRoles, type IncidentRowProps } from "../../../components/IncidentList";
import { declareIncidentAction } from "../../actions/incidents";

export const metadata = { title: "Incidents" };

const inputClass = "mt-1 rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink";

/** How many incidents the worklist lists. The rest are counted only. */
const LIST_LIMIT = 25;

/**
 * The incident worklist (M3): what is open, and the way into each incident's console.
 *
 * THE RULE THIS PAGE KEEPS
 * ------------------------
 * A worklist is not a console. This page answers one question — *what is on fire* — and
 * each row's job is to get the reader into the incident they are working on, whose own
 * page (`/incidents/<ref>`) carries the playbook, the evidence, the chain of custody,
 * the duties and the review.
 *
 * That split is not decoration. Rendering every incident in full is what made this page
 * grow with the tenant's whole history rather than with what the desk is working on: a
 * dozen incidents came to a megabyte of markup and nearly seven thousand nodes, most of
 * them the *forms* of incidents nobody had open, and that is a page a modest machine
 * crashes on. A row is about thirty nodes.
 *
 * Declaring lands on the new incident's own page for the same reason: whoever just
 * declared one is about to run its playbook, and starting it is the last thing this page
 * does for them.
 */
export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const actor = await requireActor();
  if (!actorHasPermission(actor, "ticket:read:any")) redirect("/portal");

  const { flash, error } = await searchParams;
  const now = new Date().toISOString();

  const incidents = await incidentServicesFor().list(actor.tenantId);
  // The most recent are the ones a desk is working on; the rest stay in the record, and
  // every one of them is reachable by its own address (`/incidents/<ref>`), which is
  // what a row links to. (A paged archive view is a later milestone.)
  const recent = incidents.slice(0, LIST_LIMIT);
  const older = incidents.length - recent.length;
  const incidentIds = recent.map((incident) => incident.id);

  // The two reads a row needs, both once for the whole list rather than once per
  // incident: the playbook and the counts on the record, and the deadlines that have
  // passed. The timeline, the war-room assembly and the drafts are deliberately *not*
  // read here — they belong to the page that shows them.
  const [pages, overviews] = await Promise.all([
    incidentDocsServicesFor().pages(actor.tenantId, incidentIds),
    complianceServicesFor().pages(actor.tenantId, incidentIds),
  ]);

  const rows: IncidentRowProps[] = recent.map((incident) => {
    const page = pages.get(incident.id) ?? { steps: [], evidence: [], custody: [], holds: [], artifacts: [] };
    const overview = overviews.get(incident.id);
    return {
      incident,
      steps: page.steps,
      evidence: page.evidence.length,
      artifacts: page.artifacts.length,
      holds: page.holds,
      overdue: {
        notices: (overview?.notifications ?? []).filter((obligation) => notificationState(obligation, now) === "OVERDUE").length,
        actions: (overview?.actions ?? []).filter((action) => actionState(action, now) === "OVERDUE").length,
      },
    };
  });

  const templates = await commsTemplateServicesFor().templatesFor(actor.tenantId);

  const canAct = actorHasPermission(actor, "ticket:update");
  const open = rows.filter((row) => !isIncidentClosed(row.incident.phase));
  const critical = open.filter((row) => severityRank(row.incident.severity) <= severityRank("SEV2"));
  const unstaffed = open.filter((row) => unassignedRoles(row.incident).includes("COMMANDER"));
  // The two numbers a compliance reader wants on the header, counted from the same
  // rows that carry them: a notice that has run past its window, and a review action
  // that has run past its date.
  const overdueNotices = rows.reduce((total, row) => total + (row.overdue?.notices ?? 0), 0);
  const overdueActions = rows.reduce((total, row) => total + (row.overdue?.actions ?? 0), 0);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Incidents</h1>
        <p className="text-sm text-ink-soft">
          {open.length === 0
            ? "No open incidents."
            : `${open.length} open · ${critical.length} at SEV2 or above · ${unstaffed.length} without a commander`}
        </p>
        {older > 0 ? (
          <p className="text-sm text-ink-soft">
            …and {older} older incident{older === 1 ? "" : "s"} not listed. Each one is reachable by its own
            address — <span className="font-mono text-xs">/incidents/INC-…</span> — and its reference is on the
            record wherever it is cited.
          </p>
        ) : null}
        <p className="text-sm text-ink-soft">
          <a href="/incidents/templates" className="font-semibold text-brand hover:underline">
            Notice templates
          </a>{" "}
          {templates.length > 0
            ? `— ${templates.length} draft${templates.length === 1 ? "" : "s"} of your own, offered ahead of the defaults.`
            : "— write your own draft for a duty instead of using the shipped wording."}
        </p>
        {overdueNotices > 0 || overdueActions > 0 ? (
          <p className="text-sm text-bad">
            {overdueNotices > 0 ? `${overdueNotices} regulatory notification${overdueNotices === 1 ? "" : "s"} past its deadline` : ""}
            {overdueNotices > 0 && overdueActions > 0 ? " · " : ""}
            {overdueActions > 0 ? `${overdueActions} review action${overdueActions === 1 ? "" : "s"} overdue` : ""}
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="rounded-xl2 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {error}
        </p>
      ) : null}
      {flash ? <p className="rounded-xl2 border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">{flash}</p> : null}

      {canAct ? (
        <form action={declareIncidentAction} className="space-y-3 rounded-xl2 border border-line bg-surface p-4">
          <h2 className="font-display text-base font-semibold text-ink">Declare an incident</h2>
          <p className="text-xs text-ink-faint">
            The severity comes from impact × urgency unless you set one. A SEV1/SEV2 needs a commander and a scribe before it
            can be triaged.
          </p>

          <label className="block text-sm font-medium text-ink">
            Title
            <input name="title" required className={`w-full ${inputClass}`} />
          </label>
          <label className="block text-sm font-medium text-ink">
            Summary
            <textarea name="summary" required rows={2} className={`w-full ${inputClass}`} />
          </label>

          <div className="grid gap-3 sm:grid-cols-4">
            <label className="text-sm font-medium text-ink">
              Impact
              <select name="impact" defaultValue="MODERATE" className={`block w-full ${inputClass}`}>
                {INCIDENT_IMPACTS.map((impact) => (
                  <option key={impact} value={impact}>
                    {impact}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-ink">
              Urgency
              <select name="urgency" defaultValue="MEDIUM" className={`block w-full ${inputClass}`}>
                {INCIDENT_URGENCIES.map((urgency) => (
                  <option key={urgency} value={urgency}>
                    {urgency}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-ink">
              Severity
              <select name="severity" defaultValue="" className={`block w-full ${inputClass}`}>
                <option value="">from the matrix</option>
                {INCIDENT_SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {severity}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-ink">
              Detected
              <input name="detectedAt" type="datetime-local" className={`block w-full ${inputClass}`} />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-ink">
              Related ticket (optional)
              <input name="ticketId" placeholder="ticket id" className={`block w-full ${inputClass}`} />
            </label>
            <label className="text-sm font-medium text-ink">
              Source alert (optional)
              <input name="alertId" placeholder="security alert id" className={`block w-full ${inputClass}`} />
            </label>
          </div>

          <button type="submit" className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-ink">
            Declare incident
          </button>
        </form>
      ) : (
        <p className="rounded-xl2 border border-line bg-surface p-4 text-sm text-ink-soft">
          You can see incidents but not run them.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="rounded-xl2 border border-line bg-surface p-5 text-sm text-ink-soft">
          No incidents. Nothing is on fire — declare one when something is.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <IncidentRow key={row.incident.id} {...row} />
          ))}
        </ul>
      )}
    </div>
  );
}
