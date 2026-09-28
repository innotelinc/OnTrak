/**
 * Incident console list (M3): live incidents with their playbook, evidence and
 * timeline, as a pure renderer.
 *
 * Split out of the page so the markup — the severity and phase chips, the role
 * assignment selects, the playbook steps and the evidence list — can be rendered
 * and asserted without a session or a database.
 *
 * Two things are deliberately always visible: a **skipped** playbook step (a
 * decision, not an omission) and the **timeline** (the record written as things
 * happened). Both are the point of the milestone, so neither is hidden behind a
 * disclosure.
 */

import { custodyIntegrity, holdActive, type CustodyEntry, type EvidenceItem, type LegalHold } from "../lib/evidence-rules";
import type { PlaybookStepRecord } from "../lib/incident-docs-service";
import type { IncidentEvent, IncidentRecord } from "../lib/incident-service";
import type { NotificationObligation } from "../lib/regulatory-rules";
import type { IncidentCommsTemplate } from "../lib/comms-rules";
import type { ReviewActionRecord, ReviewRecord } from "../lib/review-rules";
import type { SuggestedObligation } from "../lib/compliance-service";
import { WAR_ROOM_SOURCE_LABELS, type WarRoomEntry, type WarRoomSource, type WarRoomSummary } from "../lib/war-room-rules";
import { NotificationPanel, ReviewPanel, type NotificationActions, type ReviewActions } from "./IncidentCompliance";
import {
  INCIDENT_PHASES,
  INCIDENT_ROLES,
  assignedRoles,
  canAdvance,
  isIncidentClosed,
  phaseProgress,
  roleField,
  roleLabel,
  type IncidentPhase,
  type IncidentRole,
} from "../lib/incident-rules";
import { nextStep, playbookProgress } from "../lib/playbook-rules";
import { RETENTION_MODE_NOTES, artifactHeld, describeLock, type RetentionMode } from "../lib/object-lock-rules";
import type { EvidenceArtifactRecord } from "../lib/incident-docs-service";

export interface IncidentActions {
  advance: (formData: FormData) => Promise<void>;
  assignRole: (formData: FormData) => Promise<void>;
  addNote: (formData: FormData) => Promise<void>;
  startPlaybook: (formData: FormData) => Promise<void>;
  step: (formData: FormData) => Promise<void>;
  recordEvidence: (formData: FormData) => Promise<void>;
  /** Store a file's bytes under object-lock retention (`object-lock-rules.ts`). */
  uploadArtifact?: (formData: FormData) => Promise<void>;
  purgeArtifact?: (formData: FormData) => Promise<void>;
  transfer?: (formData: FormData) => Promise<void>;
  placeHold?: (formData: FormData) => Promise<void>;
  releaseHold?: (formData: FormData) => Promise<void>;
  /** The regulatory notification clock (`regulatory-rules.ts`). */
  notifications?: NotificationActions;
  /** The post-incident review and its tracked actions (`review-rules.ts`). */
  review?: ReviewActions;
}

export interface StaffOption {
  id: string;
  displayName: string;
  role: string;
}

export interface IncidentView {
  incident: IncidentRecord;
  steps: PlaybookStepRecord[];
  evidence: EvidenceItem[];
  /** Every hand-off for this incident's evidence, as recorded. */
  custody: CustodyEntry[];
  /** Bytes stored under object-lock retention, with the lock each one carries. */
  artifacts?: EvidenceArtifactRecord[];
  /** Holds ever placed, newest first — released ones included. */
  holds: LegalHold[];
  timeline: IncidentEvent[];
  /** Notification duties being tracked (M3 compliance). */
  notifications?: NotificationObligation[];
  /** Regimes the incident's facts suggest, and whether they are tracked. */
  suggestions?: SuggestedObligation[];
  review?: ReviewRecord | null;
  reviewActions?: ReviewActionRecord[];
  /**
   * The assembled war-room timeline: the incident log, the audit chain, the
   * alert stream and the decisions taken about it, merged and de-duplicated.
   */
  warRoom?: WarRoomEntry[];
  warRoomSummary?: WarRoomSummary;
}

export interface IncidentListProps {
  incidents: IncidentView[];
  /** The tenant's active staff, for the role selects. */
  staff: StaffOption[];
  actions?: IncidentActions;
  emptyMessage?: string;
  /**
   * The desk's name and the signed-in person's, so a notification draft can be
   * rendered from the incident's facts on the server (`comms-rules.ts`) — plus
   * the drafts the desk wrote itself, offered ahead of the shipped defaults.
   */
  comms?: { tenant: string; author: string; templates?: IncidentCommsTemplate[] };
  /** The instant the panels judge lateness against; defaults to the render clock. */
  now?: string;
}

const inputClass = "mt-1 rounded-xl2 border border-line bg-surface px-3 py-1.5 text-sm text-ink";

function chip(text: string, tone: "muted" | "brand" | "amber" | "teal" = "muted") {
  const tones = {
    muted: "bg-surface-muted text-ink-soft",
    brand: "bg-brand/10 text-brand",
    amber: "bg-amber/10 text-amber",
    teal: "bg-teal/10 text-teal",
  } as const;
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}>{text}</span>;
}

function severityTone(severity: IncidentRecord["severity"]): "amber" | "muted" {
  return severity === "SEV1" || severity === "SEV2" ? "amber" : "muted";
}

function stepTone(status: string): "muted" | "teal" | "amber" {
  if (status === "DONE") return "teal";
  if (status === "SKIPPED") return "amber";
  return "muted";
}

/** The colour a war-room source gets, so the assembled view reads at a glance. */
function sourceTone(source: WarRoomSource): "muted" | "brand" | "amber" | "teal" {
  switch (source) {
    case "log":
      return "teal";
    case "alert":
      return "amber";
    case "decision":
      return "brand";
    case "login":
    case "audit":
      return "muted";
  }
}

function PhaseStrip({ phase }: { phase: IncidentPhase }) {
  // A simple text progress bar, labelled so it is meaningful to a screen reader.
  const percent = Math.round(phaseProgress(phase) * 100);
  return (
    <div className="mt-1">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-muted" role="img" aria-label={`Lifecycle ${percent}% complete`}>
        <div className="bg-brand" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function IncidentList({
  comms, incidents, staff, actions, emptyMessage, now }: IncidentListProps) {
  // One instant for the whole render, so two panels cannot disagree about what
  // "overdue" means on the same page.
  const renderNow = now ?? new Date().toISOString();
  if (incidents.length === 0) {
    return (
      <p className="rounded-xl2 border border-line bg-surface p-5 text-sm text-ink-soft">
        {emptyMessage ?? "No incidents. Nothing is on fire — declare one when something is."}
      </p>
    );
  }

  return (
    <ul className="space-y-4">
      {incidents.map(
        ({
          incident,
          steps,
          evidence,
          custody,
          artifacts = [],
          holds,
          timeline,
          notifications = [],
          suggestions = [],
          review = null,
          reviewActions = [],
          warRoom = [],
          warRoomSummary,
        }) => {
        const manager = playbookProgress(steps);
        const upcoming = nextStep(steps);
        const hold = holds.find((entry) => holdActive(entry)) ?? null;
        return (
          <li key={incident.id} className="space-y-3 rounded-xl2 border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold text-ink">{incident.ref}</span>
              {chip(incident.severity, severityTone(incident.severity))}
              {chip(incident.phase, "brand")}
              {isIncidentClosed(incident.phase) ? chip("closed", "muted") : null}
              {hold ? chip("legal hold", "amber") : null}
              {incident.ticketId ? (
                <a href={`/inbox/${incident.ticketId}`} className="text-xs font-semibold text-brand hover:underline">
                  Ticket
                </a>
              ) : null}
              <time className="ml-auto text-[11px] text-ink-faint" dateTime={incident.declaredAt}>
                declared {incident.declaredAt}
              </time>
            </div>

            <div>
              <h3 className="font-semibold text-ink">{incident.title}</h3>
              <p className="text-sm text-ink-soft">{incident.summary}</p>
              <p className="mt-1 text-xs text-ink-faint">
                Impact {incident.impact} · urgency {incident.urgency} · detected {incident.detectedAt}
                {incident.resolvedAt ? ` · recovered ${incident.resolvedAt}` : ""}
                {incident.reviewedAt ? ` · reviewed ${incident.reviewedAt}` : ""}
              </p>
              <PhaseStrip phase={incident.phase} />
            </div>

            {/* Roles: who is accountable. */}
            <div className="grid gap-2 sm:grid-cols-2">
              {INCIDENT_ROLES.map((role: IncidentRole) => {
                const current = incident[roleField(role)];
                const person = staff.find((entry) => entry.id === current);
                return (
                  <div key={role} className="rounded-xl2 border border-line px-3 py-2">
                    <p className="text-xs font-semibold text-ink-soft">
                      {roleLabel(role)}: <span className="font-normal">{person ? person.displayName : current ? current : "unassigned"}</span>
                    </p>
                    {actions ? (
                      <form action={actions.assignRole} className="mt-1 flex items-end gap-2">
                        <input type="hidden" name="incidentId" value={incident.id} />
                        <input type="hidden" name="role" value={role} />
                        <label className="text-xs text-ink-soft">
                          <span className="sr-only">{roleLabel(role)}</span>
                          <select name="userId" defaultValue={current ?? ""} className={inputClass}>
                            <option value="">— unassigned —</option>
                            {staff.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.displayName} ({option.role})
                              </option>
                            ))}
                          </select>
                        </label>
                        <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
                          Set
                        </button>
                      </form>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {/* Lifecycle: only the legal next moves are offered. */}
            {actions ? (
              <div className="flex flex-wrap gap-2">
                {INCIDENT_PHASES.filter((phase) => canAdvance(incident.phase, phase)).map((phase) => (
                  <form key={phase} action={actions.advance}>
                    <input type="hidden" name="incidentId" value={incident.id} />
                    <input type="hidden" name="to" value={phase} />
                    <button type="submit" className="rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-white">
                      Move to {phase.toLowerCase()}
                    </button>
                  </form>
                ))}
              </div>
            ) : null}

            {/* Playbook. */}
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-semibold text-ink">Playbook</h4>
                {steps.length > 0 ? (
                  <>
                    {chip(`${manager.done}/${manager.total} done`, manager.complete ? "teal" : "muted")}
                    {manager.skipped > 0 ? chip(`${manager.skipped} skipped`, "amber") : null}
                    {upcoming ? chip(`next: ${upcoming.title}`, "brand") : null}
                  </>
                ) : (
                  chip("not started", "muted")
                )}
              </div>

              {steps.length === 0 && actions ? (
                <form action={actions.startPlaybook}>
                  <input type="hidden" name="incidentId" value={incident.id} />
                  <button type="submit" className="rounded-full border border-brand px-3 py-1.5 text-xs font-semibold text-brand">
                    Start playbook
                  </button>
                </form>
              ) : null}

              {steps.length > 0 ? (
                <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line">
                  {steps.map((step) => (
                    <li key={step.key} className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {chip(step.status.toLowerCase(), stepTone(step.status))}
                        <span className="text-sm text-ink">{step.title}</span>
                        {step.completedAt ? (
                          <time className="ml-auto text-[11px] text-ink-faint" dateTime={step.completedAt}>
                            {step.completedBy ?? "—"} · {step.completedAt}
                          </time>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-xs text-ink-soft">{step.description}</p>
                      {step.note ? <p className="mt-0.5 text-xs text-ink-faint">Note: {step.note}</p> : null}
                      {actions ? (
                        <div className="mt-1 flex flex-wrap items-end gap-2">
                          {step.status === "PENDING" ? (
                            <>
                              <form action={actions.step} className="flex items-end gap-2">
                                <input type="hidden" name="incidentId" value={incident.id} />
                                <input type="hidden" name="key" value={step.key} />
                                <input type="hidden" name="op" value="complete" />
                                <label className="text-xs text-ink-soft">
                                  <span className="sr-only">Note for {step.title}</span>
                                  <input name="note" placeholder="note (optional)" className={inputClass} />
                                </label>
                                <button type="submit" className="rounded-full bg-brand px-2.5 py-1.5 text-[11px] font-semibold text-white">
                                  Complete
                                </button>
                              </form>
                              <form action={actions.step} className="flex items-end gap-2">
                                <input type="hidden" name="incidentId" value={incident.id} />
                                <input type="hidden" name="key" value={step.key} />
                                <input type="hidden" name="op" value="skip" />
                                <label className="text-xs text-ink-soft">
                                  <span className="sr-only">Reason for skipping {step.title}</span>
                                  <input name="note" required placeholder="reason to skip" className={inputClass} />
                                </label>
                                <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
                                  Skip
                                </button>
                              </form>
                            </>
                          ) : (
                            <form action={actions.step}>
                              <input type="hidden" name="incidentId" value={incident.id} />
                              <input type="hidden" name="key" value={step.key} />
                              <input type="hidden" name="op" value="reopen" />
                              <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
                                Reopen
                              </button>
                            </form>
                          )}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>

            {/* Evidence, and the manifest that digests it. */}
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-semibold text-ink">Evidence</h4>
                <a
                  href={`/api/incidents/${incident.id}/manifest`}
                  className="ml-auto text-xs font-semibold text-brand hover:underline"
                >
                  Download manifest (JSON)
                </a>
                <a
                  href={`/api/incidents/${incident.id}/packet`}
                  className="text-xs font-semibold text-brand hover:underline"
                >
                  Download assurance packet (signed)
                </a>
              </div>
              {evidence.length === 0 ? (
                <p className="text-xs text-ink-faint">Nothing collected yet.</p>
              ) : (
                <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line">
                  {evidence.map((item) => {
                    const trail = custody.filter((entry) => entry.evidenceId === item.id);
                    const integrity = custodyIntegrity(trail, item.collectedBy);
                    return (
                      <li key={item.id} className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          {chip(item.kind.toLowerCase(), "muted")}
                          <span className="text-sm text-ink">{item.label}</span>
                          <time className="ml-auto text-[11px] text-ink-faint" dateTime={item.collectedAt}>
                            {item.collectedBy} · {item.collectedAt}
                          </time>
                        </div>
                        <p className="text-xs text-ink-soft break-all">{item.reference}</p>
                        {item.sha256 ? <p className="font-mono text-[11px] text-ink-faint">sha256 {item.sha256.slice(0, 16)}…</p> : null}

                        {/* Chain of custody: the hand-offs, and whether they join up. */}
                        <div className="mt-1 space-y-0.5">
                          <p className="text-[11px] text-ink-faint">
                            Custody: {integrity.ok ? `${integrity.entries} entr${integrity.entries === 1 ? "y" : "ies"}, held by ${integrity.holder}` : integrity.reason}
                          </p>
                          <ol className="space-y-0.5">
                            {trail.map((entry) => (
                              <li key={entry.id} className="text-[11px] text-ink-faint">
                                <time dateTime={entry.at}>{entry.at}</time> {entry.action.toLowerCase()}: {entry.fromActor} → {entry.toActor}
                                {entry.reason ? ` — ${entry.reason}` : ""}
                              </li>
                            ))}
                          </ol>
                        </div>

                        {actions?.transfer ? (
                          <form action={actions.transfer} className="mt-1 flex flex-wrap items-end gap-2">
                            <input type="hidden" name="incidentId" value={incident.id} />
                            <input type="hidden" name="evidenceId" value={item.id} />
                            <label className="text-xs text-ink-soft">
                              <span className="sr-only">New custodian for {item.label}</span>
                              <input name="toActor" required placeholder="hand to (person or team)" className={inputClass} />
                            </label>
                            <label className="text-xs text-ink-soft">
                              <span className="sr-only">Reason for moving {item.label}</span>
                              <input name="reason" required placeholder="why it moved" className={inputClass} />
                            </label>
                            <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
                              Hand off
                            </button>
                          </form>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}

              {actions ? (
                <form action={actions.recordEvidence} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="incidentId" value={incident.id} />
                  <label className="text-xs text-ink-soft">
                    Kind
                    <select name="kind" defaultValue="LOG" className={`block ${inputClass}`}>
                      {["LOG", "SNAPSHOT", "SCREENSHOT", "FILE", "NOTE", "LINK"].map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-ink-soft">
                    Label
                    <input name="label" required className={`block ${inputClass}`} />
                  </label>
                  <label className="text-xs text-ink-soft">
                    Reference
                    <input name="reference" required placeholder="storage key or URL" className={`block ${inputClass}`} />
                  </label>
                  <label className="text-xs text-ink-soft">
                    SHA-256 (optional)
                    <input name="sha256" className={`block ${inputClass}`} />
                  </label>
                  <button type="submit" className="rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-white">
                    Record evidence
                  </button>
                </form>
              ) : null}
            </section>

            {/* Artifacts: the evidence whose bytes are stored, under an object lock.
                The lock is shown rather than implied — "we kept it" and "nobody
                could have deleted it yet" are different promises. */}
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-semibold text-ink">Artifacts under lock</h4>
                <span className="text-[11px] text-ink-faint">write once, then retained by policy</span>
              </div>

              {artifacts.length === 0 ? (
                <p className="text-xs text-ink-faint">
                  No bytes stored. The evidence above points at references that live elsewhere.
                </p>
              ) : (
                <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line">
                  {artifacts.map((artifact) => {
                    const held = artifactHeld(artifact);
                    const mode: RetentionMode = artifact.mode;
                    return (
                      <li key={artifact.id} className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          {chip(held ? "locked" : "purged", held ? "teal" : "muted")}
                          <span className="font-mono text-xs text-ink">{artifact.sha256.slice(0, 16)}…</span>
                          <span className="text-[11px] text-ink-faint">
                            {artifact.bytes} B · {artifact.contentType}
                          </span>
                          <time className="ml-auto text-[11px] text-ink-faint" dateTime={artifact.lockedAt}>
                            locked {artifact.lockedAt}
                          </time>
                        </div>
                        <p className="text-[11px] break-all text-ink-faint">{artifact.key}</p>
                        <p className="text-[11px] text-ink-soft">
                          {artifact.purgedAt
                            ? `Bytes removed ${artifact.purgedAt} under the retention policy.`
                            : describeLock(artifact)}
                        </p>

                        {actions?.purgeArtifact && held ? (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-[11px] font-semibold text-ink-soft">
                              Remove the bytes…
                            </summary>
                            <form action={actions.purgeArtifact} className="mt-1 flex flex-wrap items-end gap-2">
                              <input type="hidden" name="incidentId" value={incident.id} />
                              <input type="hidden" name="artifactId" value={artifact.id} />
                              <label className="text-xs text-ink-soft">
                                <span className="sr-only">Reason for removing {artifact.key}</span>
                                <input name="reason" required placeholder="why the bytes are going" className={inputClass} />
                              </label>
                              <label className="flex items-center gap-1.5 text-[11px] text-ink-soft">
                                <input type="checkbox" name="bypass" className="size-3.5" />
                                Remove GOVERNANCE retention early
                              </label>
                              <button
                                type="submit"
                                className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft"
                              >
                                Remove bytes
                              </button>
                            </form>
                            <p className="mt-1 text-[11px] text-ink-faint">{RETENTION_MODE_NOTES[mode]}</p>
                          </details>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}

              {actions?.uploadArtifact ? (
                <form action={actions.uploadArtifact} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="incidentId" value={incident.id} />
                  <label className="text-xs text-ink-soft">
                    Kind
                    <select name="kind" defaultValue="FILE" className={`block ${inputClass}`}>
                      {["LOG", "SNAPSHOT", "SCREENSHOT", "FILE", "NOTE", "LINK"].map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-ink-soft">
                    Label
                    <input name="label" placeholder="defaults to the file name" className={`block ${inputClass}`} />
                  </label>
                  <label className="text-xs text-ink-soft">
                    File
                    <input name="file" type="file" required className={`block ${inputClass}`} />
                  </label>
                  <button type="submit" className="rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-white">
                    Store artifact
                  </button>
                </form>
              ) : null}
            </section>

            {/* Legal hold: it outranks routine retention, so it is never hidden. */}
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-semibold text-ink">Legal hold</h4>
                {hold ? chip("in force", "amber") : chip("none", "muted")}
              </div>
              {hold ? (
                <p className="text-xs text-ink-soft">
                  {hold.reason} — placed by {hold.placedBy} at {hold.placedAt}
                </p>
              ) : (
                <p className="text-xs text-ink-faint">Routine retention applies.</p>
              )}
              {holds.length > 0 ? (
                <ol className="space-y-0.5">
                  {holds.map((entry) => (
                    <li key={entry.id} className="text-[11px] text-ink-faint">
                      <time dateTime={entry.placedAt}>{entry.placedAt}</time> placed — {entry.reason}
                      {entry.releasedAt ? ` · released ${entry.releasedAt}` : ""}
                    </li>
                  ))}
                </ol>
              ) : null}

              {actions?.placeHold && actions.releaseHold ? (
                <div className="flex flex-wrap items-end gap-2">
                  {hold ? (
                    <form action={actions.releaseHold} className="flex items-end gap-2">
                      <input type="hidden" name="incidentId" value={incident.id} />
                      <label className="text-xs text-ink-soft">
                        <span className="sr-only">Reason for releasing the hold on {incident.ref}</span>
                        <input name="reason" required placeholder="why the hold is lifted" className={inputClass} />
                      </label>
                      <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
                        Release hold
                      </button>
                    </form>
                  ) : (
                    <form action={actions.placeHold} className="flex items-end gap-2">
                      <input type="hidden" name="incidentId" value={incident.id} />
                      <label className="text-xs text-ink-soft">
                        <span className="sr-only">Reason for holding {incident.ref}</span>
                        <input name="reason" required placeholder="why preservation is required" className={inputClass} />
                      </label>
                      <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
                        Place legal hold
                      </button>
                    </form>
                  )}
                </div>
              ) : null}
            </section>

            {/* The duty the incident created, and whether it was met in time. */}
            <NotificationPanel
              incidentId={incident.id}
              obligations={notifications}
              suggestions={suggestions}
              {...(comms
                ? {
                    comms: {
                      incident: {
                        ref: incident.ref,
                        title: incident.title,
                        severity: incident.severity,
                        phase: incident.phase,
                        impact: incident.impact,
                        detectedAt: incident.detectedAt,
                        declaredAt: incident.declaredAt,
                      },
                      tenant: comms.tenant,
                      author: comms.author,
                      ...(comms.templates ? { templates: comms.templates } : {}),
                    },
                  }
                : {})}
              now={renderNow}
              {...(actions?.notifications ? { actions: actions.notifications } : {})}
            />

            {/* The review that turns the incident into work with owners. */}
            <ReviewPanel
              incidentId={incident.id}
              review={review}
              actions={reviewActions}
              staff={staff}
              reviewable={incident.phase === "REVIEWED"}
              now={renderNow}
              {...(actions?.review ? { onAction: actions.review } : {})}
            />

            {/* The incident's story told by every system that witnessed it. */ }
            {warRoom.length > 0 ? (
              <section className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-semibold text-ink">War-room timeline</h4>
                  {warRoomSummary ? chip(`${warRoomSummary.total} lines`, "muted") : null}
                  {warRoomSummary && warRoomSummary.corroborated > 0
                    ? chip(`${warRoomSummary.corroborated} corroborated`, "teal")
                    : null}
                  <span className="text-[11px] text-ink-faint">
                    assembled from the incident log, sign-ins, the alert stream and the decisions taken about it
                  </span>
                </div>
                <ol className="space-y-1">
                  {warRoom.slice(-10).map((entry) => (
                    <li key={entry.id} className="flex flex-wrap items-baseline gap-2 text-xs text-ink-soft">
                      <time className="text-ink-faint" dateTime={entry.at}>
                        {entry.at}
                      </time>
                      {entry.sources.map((source) => (
                        <span key={source}>{chip(WAR_ROOM_SOURCE_LABELS[source], sourceTone(source))}</span>
                      ))}
                      <span className="text-ink">{entry.summary}</span>
                      <span className="text-ink-faint">— {entry.actor}</span>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            {/* The incident log: written as things happened. */}
            <section className="space-y-1">
              <h4 className="text-sm font-semibold text-ink">Incident log</h4>
              <ol className="space-y-1">
                {timeline.slice(-8).map((event) => (
                  <li key={event.id} className="flex flex-wrap items-baseline gap-2 text-xs text-ink-soft">
                    <time className="text-ink-faint" dateTime={event.at}>
                      {event.at}
                    </time>
                    {chip(event.kind, "muted")}
                    <span className="text-ink">{event.summary}</span>
                    <span className="text-ink-faint">— {event.actor}</span>
                  </li>
                ))}
              </ol>
              {actions ? (
                <form action={actions.addNote} className="flex items-end gap-2 pt-1">
                  <input type="hidden" name="incidentId" value={incident.id} />
                  <label className="flex-1 text-xs text-ink-soft">
                    <span className="sr-only">Timeline note for {incident.ref}</span>
                    <input name="summary" required placeholder="Add a timeline note…" className="w-full rounded-xl2 border border-line bg-surface px-3 py-1.5 text-sm text-ink" />
                  </label>
                  <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
                    Add note
                  </button>
                </form>
              ) : null}
            </section>
          </li>
        );
        },
      )}
    </ul>
  );
}

/** The roles currently unassigned, for a page summary. */
export function unassignedRoles(incident: IncidentRecord): IncidentRole[] {
  return assignedRoles(incident)
    .filter(({ userId }) => userId === null)
    .map(({ role }) => role);
}
