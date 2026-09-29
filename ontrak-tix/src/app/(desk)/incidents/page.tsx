import { redirect } from "next/navigation";

import { requireActor } from "../../../lib/session";
import { hasPermission } from "../../../lib/access-rules";
import {
  commsTemplateServicesFor,
  complianceServicesFor,
  incidentDocsServicesFor,
  incidentServicesFor,
  prisma,
  warRoomServicesFor,
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
import { suggestionsFrom } from "../../../lib/compliance-service";
import { IncidentList, unassignedRoles, type IncidentView } from "../../../components/IncidentList";
import {
  acknowledgeNotificationAction,
  addIncidentNoteAction,
  addReviewActionAction,
  advanceIncidentAction,
  assignIncidentRoleAction,
  declareIncidentAction,
  placeLegalHoldAction,
  playbookStepAction,
  publishReviewAction,
  purgeArtifactAction,
  recordEvidenceAction,
  releaseLegalHoldAction,
  reviewActionStateAction,
  sendNotificationAction,
  startPlaybookAction,
  trackNotificationAction,
  transferEvidenceAction,
  uploadArtifactAction,
  waiveNotificationAction,
} from "../../actions/incidents";

export const metadata = { title: "Incidents" };

const inputClass = "mt-1 rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink";

/** How many incidents the console renders in full. The rest are counted only. */
const RECENT_LIMIT = 12;

/**
 * The incident console (M3): declare an incident, move it through the lifecycle,
 * name the people who own it, run its playbook and collect its evidence.
 *
 * Staff-only. The severity matrix, the phase ladder and the playbook are all
 * decided by the services behind this page — the page only offers the moves that
 * are legal and shows what the record already says.
 */
export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const actor = await requireActor();
  if (!hasPermission(actor.role, "ticket:read:any")) redirect("/portal");

  const { flash, error } = await searchParams;
  const service = incidentServicesFor();
  const docs = incidentDocsServicesFor();
  const compliance = complianceServicesFor();
  const warRoom = warRoomServicesFor();
  const now = new Date().toISOString();

  const incidents = await service.list(actor.tenantId);
  // A console renders each incident in full — playbook, evidence, custody,
  // timeline, duties and review — so an unbounded list means a page that grows
  // with the tenant's whole incident history. The most recent are the ones a
  // desk is working on; the rest stay in the record and reachable by their own
  // links. (The archive view is a later milestone.)
  const recent = incidents.slice(0, RECENT_LIMIT);
  const older = incidents.length - recent.length;
  const incidentIds = recent.map((incident) => incident.id);

  // Everything below is read once for the whole page rather than once per
  // incident. The console lists every incident with its playbook, evidence,
  // timeline, duties and review — reading those incident by incident multiplies
  // a ten-query page by the length of the list.
  const [pages, timelinePages, timelines, overviews] = await Promise.all([
    docs.pages(actor.tenantId, incidentIds),
    service.timelinesFor(actor.tenantId, recent),
    warRoom.timelines(actor, recent),
    compliance.pages(actor.tenantId, incidentIds),
  ]);

  const views: IncidentView[] = recent.map((incident) => {
    const page = pages.get(incident.id) ?? { steps: [], evidence: [], custody: [], holds: [], artifacts: [] };
    const overview = overviews.get(incident.id) ?? {
      notifications: [],
      summary: { total: 0, pending: 0, dueSoon: 0, overdue: 0, sent: 0, acknowledged: 0, waived: 0, nextDueAt: null },
      review: null,
      actions: [],
      reviewSummary: { total: 0, open: 0, inProgress: 0, overdue: 0, done: 0, dropped: 0, closedShare: 0, settled: false },
    };
    const warRoomTimeline = timelines.ok ? timelines.value.get(incident.id) : undefined;

    return {
      incident,
      steps: page.steps,
      evidence: page.evidence,
      custody: page.custody,
      artifacts: page.artifacts,
      holds: page.holds,
      timeline: timelinePages.get(incident.id) ?? [],
      notifications: overview.notifications,
      suggestions: suggestionsFrom(incident, overview.notifications),
      review: overview.review,
      reviewActions: overview.actions,
      warRoom: warRoomTimeline?.entries ?? [],
      ...(warRoomTimeline ? { warRoomSummary: warRoomTimeline.summary } : {}),
    };
  });

  const staff = await prisma.user.findMany({
    where: { tenantId: actor.tenantId, active: true },
    select: { id: true, displayName: true, role: true },
    orderBy: { displayName: "asc" },
  });

  // A notification draft speaks for the desk (its name) and is signed by whoever
  // records it, so those two names are read once for the page — along with the
  // drafts the desk wrote itself, which are offered ahead of the shipped ones.
  const [tenant, templates] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { name: true } }),
    commsTemplateServicesFor().templatesFor(actor.tenantId),
  ]);
  const comms = {
    tenant: tenant?.name ?? actor.tenantId,
    author: staff.find((person) => person.id === actor.id)?.displayName ?? actor.id,
    templates,
  };

  const canAct = hasPermission(actor.role, "ticket:update");
  const open = views.filter((view) => !isIncidentClosed(view.incident.phase));
  const critical = open.filter((view) => severityRank(view.incident.severity) <= severityRank("SEV2"));
  const unstaffed = open.filter((view) => unassignedRoles(view.incident).includes("COMMANDER"));
  // The two numbers a compliance reader wants on the header: a notice that has
  // run past its window, and a review action that has run past its date.
  const overdueNotices = views.flatMap((view) => view.notifications ?? []).filter((obligation) => notificationState(obligation, now) === "OVERDUE").length;
  const overdueActions = views.flatMap((view) => view.reviewActions ?? []).filter((action) => actionState(action, now) === "OVERDUE").length;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Incidents</h1>
        <p className="text-sm text-ink-soft">
          {open.length === 0
            ? "No open incidents."
            : `${open.length} open · ${critical.length} at SEV2 or above · ${unstaffed.length} without a commander`}
        </p>
        {older > 0 ? <p className="text-sm text-ink-soft">…and {older} older incident{older === 1 ? "" : "s"} not shown.</p> : null}
        <p className="text-sm text-ink-soft">
          <a href="/incidents/templates" className="font-semibold text-brand hover:underline">
            Notice templates
          </a>{" "}
          {comms.templates.length > 0
            ? `— ${comms.templates.length} draft${comms.templates.length === 1 ? "" : "s"} of your own, offered ahead of the defaults.`
            : "— write your own draft for a duty instead of using the shipped wording."}
        </p>
        {overdueNotices > 0 || overdueActions > 0 ? (
          <p className="text-sm text-pink">
            {overdueNotices > 0 ? `${overdueNotices} regulatory notification${overdueNotices === 1 ? "" : "s"} past its deadline` : ""}
            {overdueNotices > 0 && overdueActions > 0 ? " · " : ""}
            {overdueActions > 0 ? `${overdueActions} review action${overdueActions === 1 ? "" : "s"} overdue` : ""}
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
          {error}
        </p>
      ) : null}
      {flash ? <p className="rounded-xl2 border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">{flash}</p> : null}

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

      <IncidentList
        incidents={views}
        staff={staff}
        comms={comms}
        now={now}
        {...(canAct
          ? {
              actions: {
                advance: advanceIncidentAction,
                assignRole: assignIncidentRoleAction,
                addNote: addIncidentNoteAction,
                startPlaybook: startPlaybookAction,
                step: playbookStepAction,
                recordEvidence: recordEvidenceAction,
                uploadArtifact: uploadArtifactAction,
                purgeArtifact: purgeArtifactAction,
                transfer: transferEvidenceAction,
                placeHold: placeLegalHoldAction,
                releaseHold: releaseLegalHoldAction,
                notifications: {
                  track: trackNotificationAction,
                  send: sendNotificationAction,
                  acknowledge: acknowledgeNotificationAction,
                  waive: waiveNotificationAction,
                },
                review: { publish: publishReviewAction, add: addReviewActionAction, state: reviewActionStateAction },
              },
            }
          : {})}
      />
    </div>
  );
}
