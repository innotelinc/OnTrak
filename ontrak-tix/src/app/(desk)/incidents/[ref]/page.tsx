import { notFound, redirect } from "next/navigation";

import { requireActor } from "../../../../lib/session";
import { actorHasPermission } from "../../../../lib/access-rules";
import {
  commsTemplateServicesFor,
  complianceServicesFor,
  incidentDocsServicesFor,
  incidentServicesFor,
  prisma,
  warRoomServicesFor,
} from "../../../../lib/db";
import { suggestionsFrom } from "../../../../lib/compliance-service";
import { isIncidentClosed } from "../../../../lib/incident-rules";
import { IncidentList, type IncidentView } from "../../../../components/IncidentList";
import {
  acknowledgeNotificationAction,
  addIncidentNoteAction,
  addReviewActionAction,
  advanceIncidentAction,
  assignIncidentRoleAction,
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
} from "../../../actions/incidents";

export const metadata = { title: "Incident" };

/**
 * One incident's console (M3): its playbook, its evidence, the chain of custody, the
 * duties its facts created and the review that closes it out.
 *
 * THE ADDRESS IS THE REFERENCE
 * ----------------------------
 * `/incidents/INC-000123` rather than an opaque row id: the reference is what is written
 * on the ticket, quoted in a notification, and read out in a stand-up, so it is the one
 * handle somebody can be given. The page accepts the record's own id as well, because a
 * form action that only knows the id has to be able to answer here.
 *
 * Everything below is read for **one** incident. That is the point of this page
 * existing: the worklist shows rows, and the ten-odd reads an incident needs — its
 * playbook, its evidence and custody, the assembled war-room timeline, its duties and
 * its review — happen when somebody opens it, not once per incident on a list.
 */
export default async function IncidentPage({
  params,
  searchParams,
}: {
  params: Promise<{ ref: string }>;
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const actor = await requireActor();
  if (!actorHasPermission(actor, "ticket:read:any")) redirect("/portal");

  const { ref } = await params;
  const { flash, error } = await searchParams;

  const service = incidentServicesFor();
  const incidents = await service.list(actor.tenantId);
  const incident = incidents.find((entry) => entry.ref === ref || entry.id === ref);
  if (!incident) notFound();

  const docs = incidentDocsServicesFor();
  const compliance = complianceServicesFor();
  const warRoom = warRoomServicesFor();
  const now = new Date().toISOString();

  const [pages, timelinePages, timelines, overviews] = await Promise.all([
    docs.pages(actor.tenantId, [incident.id]),
    service.timelinesFor(actor.tenantId, [incident]),
    warRoom.timelines(actor, [incident]),
    compliance.pages(actor.tenantId, [incident.id]),
  ]);

  const page = pages.get(incident.id) ?? { steps: [], evidence: [], custody: [], holds: [], artifacts: [] };
  const overview = overviews.get(incident.id) ?? {
    notifications: [],
    summary: { total: 0, pending: 0, dueSoon: 0, overdue: 0, sent: 0, acknowledged: 0, waived: 0, nextDueAt: null },
    review: null,
    actions: [],
    reviewSummary: { total: 0, open: 0, inProgress: 0, overdue: 0, done: 0, dropped: 0, closedShare: 0, settled: false },
  };
  const warRoomTimeline = timelines.ok ? timelines.value.get(incident.id) : undefined;

  const view: IncidentView = {
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

  const staff = await prisma.user.findMany({
    where: { tenantId: actor.tenantId, active: true },
    select: { id: true, displayName: true, role: true },
    orderBy: { displayName: "asc" },
  });

  // A notification draft speaks for the desk (its name) and is signed by whoever
  // records it, so those two names are read once for the page — along with the drafts
  // the desk wrote itself, which are offered ahead of the shipped ones.
  const [tenant, templates] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { name: true } }),
    commsTemplateServicesFor().templatesFor(actor.tenantId),
  ]);
  const comms = {
    tenant: tenant?.name ?? actor.tenantId,
    author: staff.find((person) => person.id === actor.id)?.displayName ?? actor.id,
    templates,
  };

  const canAct = actorHasPermission(actor, "ticket:update");
  const closed = isIncidentClosed(incident.phase);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <p className="text-sm text-ink-soft">
          <a href="/incidents" className="font-semibold text-brand hover:underline">
            ← All incidents
          </a>
        </p>
        <h1 className="font-display text-xl font-semibold text-ink">
          {incident.ref} · {incident.title}
        </h1>
        <p className="text-sm text-ink-soft">
          {incident.severity} · {incident.phase.toLowerCase()} · declared {incident.declaredAt}
          {closed ? " · this incident is closed out; its record stays." : ""}
        </p>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl2 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {error}
        </p>
      ) : null}
      {flash ? <p className="rounded-xl2 border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">{flash}</p> : null}

      <IncidentList
        incidents={[view]}
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
