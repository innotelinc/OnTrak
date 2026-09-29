/**
 * Compliance panels for the incident console (M3): the regulatory notification
 * clocks, and the post-incident review with its tracked actions.
 *
 * Pure renderers, like `IncidentList`: they take the rows, the `now` they are
 * judged against, and the actions to call — nothing else. That keeps "is this
 * notice late?" a property of the markup that a test can assert, rather than
 * something the page works out inline.
 *
 * The two panels are deliberately blunt about state. An overdue notice says
 * *overdue* in words, an action past its due date says so, and a review that
 * cannot be published yet says why — because the failure mode this milestone
 * exists to prevent is a duty that quietly lapsed.
 */

import {
  notificationLateness,
  notificationState,
  notificationStateLabel,
  NOTIFICATION_REGIMES,
  canSend,
  canAcknowledge,
  canWaive,
  type NotificationObligation,
} from "../lib/regulatory-rules";
import { audienceLabel, commsDrafts, type CommsFacts, type IncidentCommsTemplate } from "../lib/comms-rules";
import type { SuggestedObligation } from "../lib/compliance-service";
import {
  actionState,
  actionStateLabel,
  isActionClosed,
  type ReviewActionRecord,
  type ReviewRecord,
} from "../lib/review-rules";
import type { StaffOption } from "./IncidentList";

export interface NotificationActions {
  track: (formData: FormData) => Promise<void>;
  send: (formData: FormData) => Promise<void>;
  acknowledge: (formData: FormData) => Promise<void>;
  waive: (formData: FormData) => Promise<void>;
}

export interface ReviewActions {
  publish: (formData: FormData) => Promise<void>;
  add: (formData: FormData) => Promise<void>;
  state: (formData: FormData) => Promise<void>;
}

export interface NotificationPanelProps {
  incidentId: string;
  obligations: NotificationObligation[];
  /** Regimes this incident's facts suggest, and whether they are tracked. */
  suggestions: SuggestedObligation[];
  /**
   * The incident's own facts, so a notice can be drafted from them — plus any
   * drafts the desk wrote itself, which are offered ahead of the shipped ones.
   */
  comms?: CommsFacts & { templates?: IncidentCommsTemplate[] };
  now: string;
  actions?: NotificationActions;
}

export interface ReviewPanelProps {
  incidentId: string;
  review: ReviewRecord | null;
  actions: ReviewActionRecord[];
  staff: StaffOption[];
  /** The incident has reached `REVIEWED`, so publishing is allowed. */
  reviewable: boolean;
  now: string;
  onAction?: ReviewActions;
}

const inputClass = "mt-1 rounded-xl2 border border-line bg-surface px-3 py-1.5 text-sm text-ink";

type Tone = "muted" | "brand" | "amber" | "teal" | "pink";

function chip(text: string, tone: Tone = "muted") {
  const tones = {
    muted: "bg-surface-muted text-ink-soft",
    brand: "bg-brand/10 text-brand",
    amber: "bg-attention/10 text-attention",
    teal: "bg-ok/10 text-ok",
    pink: "bg-bad/10 text-bad",
  } as const;
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}>{text}</span>;
}

function stateTone(state: string): Tone {
  if (state === "OVERDUE" || state === "SENT_LATE") return "pink";
  if (state === "DUE_SOON") return "amber";
  if (state === "SENT" || state === "ACKNOWLEDGED" || state === "DONE") return "teal";
  if (state === "WAIVED" || state === "DROPPED") return "muted";
  return "brand";
}

const btnPrimary = "rounded-full bg-brand px-2.5 py-1.5 text-[11px] font-semibold text-brand-ink";
const btnQuiet = "rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft";

/* -------------------------------------------------------------------------- */
/*  Regulatory notifications                                                  */
/* -------------------------------------------------------------------------- */

export function NotificationPanel({ incidentId, obligations, suggestions, comms, now, actions }: NotificationPanelProps) {
  const untracked = suggestions.filter((entry) => !entry.tracked);
  const extra = NOTIFICATION_REGIMES.filter(
    (regime) => !obligations.some((obligation) => obligation.regime === regime.key) && !untracked.some((entry) => entry.suggestion.regime.key === regime.key),
  );

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-ink">Regulatory notifications</h4>
        {obligations.length === 0 ? chip("nothing tracked", "muted") : null}
        {obligations.filter((obligation) => notificationState(obligation, now) === "OVERDUE").map((obligation) => (
          <span key={obligation.id}>{chip("overdue", "pink")}</span>
        ))}
      </div>

      {obligations.length > 0 ? (
        <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line">
          {obligations.map((obligation) => {
            const state = notificationState(obligation, now);
            const lateness = notificationLateness(obligation);
            return (
              <li key={obligation.id} className="space-y-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  {chip(notificationStateLabel(state), stateTone(state))}
                  <span className="text-sm font-medium text-ink">{obligation.label}</span>
                  <span className="text-xs text-ink-soft">→ {obligation.authority}</span>
                  <time className="ml-auto text-[11px] text-ink-faint" dateTime={obligation.dueAt}>
                    due {obligation.dueAt}
                  </time>
                </div>
                <p className="text-xs text-ink-soft">{obligation.requirement}</p>
                <p className="text-[11px] text-ink-faint">
                  clock: {obligation.clock === "detected" ? "from detection" : "from declaration"}
                  {obligation.sentAt
                    ? ` · sent ${obligation.sentAt}${lateness === null ? "" : lateness > 0 ? ` (${lateness}h late)` : ` (${Math.abs(lateness)}h early)`}`
                    : ""}
                  {obligation.reference ? ` · ref ${obligation.reference}` : ""}
                  {obligation.waivedAt ? ` · waived: ${obligation.waiverReason}` : ""}
                </p>

                {/* What went out, kept verbatim — the draft was a proposal. */}
                {obligation.message ? (
                  <details className="pt-0.5">
                    <summary className="cursor-pointer text-[11px] font-semibold text-ink-soft">
                      Notice text as sent ({obligation.message.length} characters)
                    </summary>
                    <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-xl2 border border-line bg-surface-muted px-2 py-1.5 text-[11px] text-ink-soft">
                      {obligation.message}
                    </pre>
                  </details>
                ) : null}

                {actions ? (
                  <div className="flex flex-wrap items-end gap-2 pt-0.5">
                    {canSend(obligation) ? (
                      <form action={actions.send} className="flex items-end gap-2">
                        <input type="hidden" name="incidentId" value={incidentId} />
                        <input type="hidden" name="notificationId" value={obligation.id} />
                        <label className="text-xs text-ink-soft">
                          Reference
                          <input name="reference" placeholder="authority ref (optional)" className={`block ${inputClass}`} />
                        </label>
                        <button type="submit" className={btnPrimary}>
                          Mark sent
                        </button>
                      </form>
                    ) : null}
                    {canSend(obligation) && comms
                      ? (() => {
                          const drafts = commsDrafts(
                            { incident: comms.incident, obligation, tenant: comms.tenant, author: comms.author },
                            comms.templates ?? [],
                          );
                          return (
                            <details className="w-full rounded-xl2 border border-line p-2">
                              <summary className="cursor-pointer text-[11px] font-semibold text-ink-soft">
                                Draft this notice ({drafts.length}) — the words, with this incident's facts in them
                              </summary>
                              <div className="space-y-2 pt-2">
                                {drafts.map((draft) => (
                                  <div key={draft.template.key} className="space-y-1 rounded-xl2 border border-line p-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="text-xs font-semibold text-ink">{draft.template.label}</span>
                                      {chip(audienceLabel(draft.template.audience), "brand")}
                                      {draft.custom ? chip("yours", "teal") : null}
                                      {draft.fallback ? chip("generic", "amber") : null}
                                      {draft.ready
                                        ? chip("ready", "teal")
                                        : chip(`${draft.fillIn.length} field${draft.fillIn.length === 1 ? "" : "s"} to complete`, "amber")}
                                    </div>
                                    <p className="text-[11px] text-ink-faint">{draft.template.guidance}</p>
                                    {draft.issues.length > 0 ? (
                                      <ul className="list-disc pl-4 text-[11px] text-attention">
                                        {draft.issues.map((issue) => (
                                          <li key={issue}>{issue}</li>
                                        ))}
                                      </ul>
                                    ) : null}
                                    {/* The draft is a starting point, not a constraint: edit it, then record it. */}
                                    <form action={actions.send} className="space-y-1">
                                      <input type="hidden" name="incidentId" value={incidentId} />
                                      <input type="hidden" name="notificationId" value={obligation.id} />
                                      <input type="hidden" name="templateKey" value={draft.template.key} />
                                      <label className="block text-xs text-ink-soft">
                                        Notice text — fill in the gaps, then record it
                                        <textarea
                                          name="message"
                                          rows={10}
                                          defaultValue={draft.message}
                                          className={`w-full font-mono text-[11px] ${inputClass}`}
                                        />
                                      </label>
                                      <div className="flex flex-wrap items-end gap-2">
                                        <label className="text-xs text-ink-soft">
                                          Reference
                                          <input name="reference" placeholder="reference for this notice (optional)" className={`block ${inputClass}`} />
                                        </label>
                                        <button type="submit" className={btnPrimary}>
                                          Record this notice as sent
                                        </button>
                                      </div>
                                    </form>
                                  </div>
                                ))}
                              </div>
                            </details>
                          );
                        })()
                      : null}
                    {canAcknowledge(obligation) ? (
                      <form action={actions.acknowledge}>
                        <input type="hidden" name="incidentId" value={incidentId} />
                        <input type="hidden" name="notificationId" value={obligation.id} />
                        <button type="submit" className={btnQuiet}>
                          Mark acknowledged
                        </button>
                      </form>
                    ) : null}
                    {canWaive(obligation) ? (
                      <form action={actions.waive} className="flex items-end gap-2">
                        <input type="hidden" name="incidentId" value={incidentId} />
                        <input type="hidden" name="notificationId" value={obligation.id} />
                        <label className="text-xs text-ink-soft">
                          Reason to waive
                          <input name="reason" required placeholder="why this does not apply" className={`block ${inputClass}`} />
                        </label>
                        <button type="submit" className={btnQuiet}>
                          Waive
                        </button>
                      </form>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-ink-faint">
          No notification duty is being tracked. Adopting one starts its clock and puts the deadline on the record.
        </p>
      )}

      {actions && untracked.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11px] text-ink-faint">Suggested for this incident:</p>
          <ul className="space-y-1">
            {untracked.map(({ suggestion }) => (
              <li key={suggestion.regime.key} className="flex flex-wrap items-center gap-2">
                <form action={actions.track} className="flex items-center gap-2">
                  <input type="hidden" name="incidentId" value={incidentId} />
                  <input type="hidden" name="regime" value={suggestion.regime.key} />
                  <button type="submit" className={btnQuiet}>
                    Track {suggestion.regime.label}
                  </button>
                </form>
                <span className="text-[11px] text-ink-faint">because {suggestion.because}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {actions && extra.length > 0 ? (
        <form action={actions.track} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="incidentId" value={incidentId} />
          <label className="text-xs text-ink-soft">
            Track another regime
            <select name="regime" defaultValue={extra[0].key} className={`block ${inputClass}`}>
              {extra.map((regime) => (
                <option key={regime.key} value={regime.key}>
                  {regime.label} ({regime.hours}h)
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={btnQuiet}>
            Track
          </button>
        </form>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Post-incident review                                                      */
/* -------------------------------------------------------------------------- */

/** One row of the publish form: a title, an owner and a due date. */
function ActionRow({ index, staff, required }: { index: number; staff: StaffOption[]; required: boolean }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <label className="text-xs text-ink-soft">
        Action {index + 1}
        <input name={`actionTitle-${index}`} required={required} placeholder={required ? "what will change" : "another action (optional)"} className={`block w-full ${inputClass}`} />
      </label>
      <label className="text-xs text-ink-soft">
        Owner
        <select name={`actionOwner-${index}`} required={required} defaultValue="" className={`block w-full ${inputClass}`}>
          <option value="">— choose an owner —</option>
          {staff.map((person) => (
            <option key={person.id} value={person.id}>
              {person.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-ink-soft">
        Due
        <input name={`actionDue-${index}`} type="date" required={required} className={`block w-full ${inputClass}`} />
      </label>
    </div>
  );
}

export function ReviewPanel({ incidentId, review, actions, staff, reviewable, now, onAction }: ReviewPanelProps) {
  const overdue = actions.filter((action) => actionState(action, now) === "OVERDUE").length;
  const closed = actions.filter(isActionClosed).length;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-ink">Post-incident review</h4>
        {review ? chip("published", "teal") : chip("not published", "muted")}
        {actions.length > 0 ? chip(`${closed}/${actions.length} actions closed`, overdue > 0 ? "amber" : "muted") : null}
        {overdue > 0 ? chip(`${overdue} overdue`, "pink") : null}
      </div>

      {review ? (
        <div className="space-y-1">
          <p className="text-sm text-ink whitespace-pre-line">{review.findings}</p>
          {review.lessons ? <p className="text-xs text-ink-soft whitespace-pre-line">Lessons: {review.lessons}</p> : null}
          <p className="text-[11px] text-ink-faint">
            published by {review.publishedBy} at {review.publishedAt}
          </p>
        </div>
      ) : reviewable ? (
        <form action={onAction?.publish} className="space-y-2 rounded-xl2 border border-line p-3">
          <input type="hidden" name="incidentId" value={incidentId} />
          <p className="text-xs text-ink-faint">
            A review is only published with at least one action that has an owner and a due date — otherwise nothing changes.
          </p>
          <label className="block text-xs text-ink-soft">
            Findings
            <textarea name="findings" required rows={3} className={`w-full ${inputClass}`} />
          </label>
          <label className="block text-xs text-ink-soft">
            Lessons (optional)
            <textarea name="lessons" rows={2} className={`w-full ${inputClass}`} />
          </label>
          <ActionRow index={0} staff={staff} required />
          <ActionRow index={1} staff={staff} required={false} />
          <button type="submit" className={btnPrimary}>
            Publish review
          </button>
        </form>
      ) : (
        <p className="text-xs text-ink-faint">Move the incident to reviewed to publish its post-incident review.</p>
      )}

      {actions.length > 0 ? (
        <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line">
          {actions.map((action) => {
            const state = actionState(action, now);
            const owner = staff.find((person) => person.id === action.ownerId);
            return (
              <li key={action.id} className="space-y-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  {chip(actionStateLabel(state), stateTone(state))}
                  <span className="text-sm text-ink">{action.title}</span>
                  <span className="text-xs text-ink-soft">owner {owner ? owner.displayName : action.ownerId}</span>
                  <time className="ml-auto text-[11px] text-ink-faint" dateTime={action.dueAt}>
                    due {action.dueAt.slice(0, 10)}
                  </time>
                </div>
                {action.note ? <p className="text-xs text-ink-faint">Note: {action.note}</p> : null}
                {action.completedAt ? (
                  <p className="text-[11px] text-ink-faint">
                    closed by {action.completedBy} at {action.completedAt}
                  </p>
                ) : null}

                {onAction && !isActionClosed(action) ? (
                  <div className="flex flex-wrap items-end gap-2">
                    {action.status === "OPEN" ? (
                      <form action={onAction.state}>
                        <input type="hidden" name="incidentId" value={incidentId} />
                        <input type="hidden" name="actionId" value={action.id} />
                        <input type="hidden" name="op" value="start" />
                        <button type="submit" className={btnQuiet}>
                          Start action
                        </button>
                      </form>
                    ) : null}
                    <form action={onAction.state} className="flex items-end gap-2">
                      <input type="hidden" name="incidentId" value={incidentId} />
                      <input type="hidden" name="actionId" value={action.id} />
                      <input type="hidden" name="op" value="complete" />
                      <label className="text-xs text-ink-soft">
                        What was done
                        <input name="note" placeholder="what was done (optional)" className={`block ${inputClass}`} />
                      </label>
                      <button type="submit" className={btnPrimary}>
                        Complete action
                      </button>
                    </form>
                    <form action={onAction.state} className="flex items-end gap-2">
                      <input type="hidden" name="incidentId" value={incidentId} />
                      <input type="hidden" name="actionId" value={action.id} />
                      <input type="hidden" name="op" value="drop" />
                      <label className="text-xs text-ink-soft">
                        Reason to drop
                        <input name="reason" required placeholder="why it is not being done" className={`block ${inputClass}`} />
                      </label>
                      <button type="submit" className={btnQuiet}>
                        Drop action
                      </button>
                    </form>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {onAction && review ? (
        <form action={onAction.add} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="incidentId" value={incidentId} />
          <label className="text-xs text-ink-soft">
            New action
            <input name="title" required placeholder="what will change" className={`block ${inputClass}`} />
          </label>
          <label className="text-xs text-ink-soft">
            Owner
            <select name="ownerId" required defaultValue="" className={`block ${inputClass}`}>
              <option value="">— choose an owner —</option>
              {staff.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-soft">
            Due
            <input name="dueAt" type="date" required className={`block ${inputClass}`} />
          </label>
          <button type="submit" className={btnQuiet}>
            Add action
          </button>
        </form>
      ) : null}
    </section>
  );
}
