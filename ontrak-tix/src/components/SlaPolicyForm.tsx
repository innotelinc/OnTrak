/**
 * SLA promise authoring (M4).
 *
 * One form for both jobs — writing a promise and changing one — because the two
 * differ only by the id the caller already has. Two sibling forms rather than
 * one nested: the remove button posts to a different action, and a form inside a
 * form is not a thing HTML offers.
 *
 * Presentational. The permission, the validation and the audit event are the
 * service's; this only renders the fields a person fills in.
 */

import type { SlaPolicyRecord, SlaHours } from "../lib/sla-policy-service";
import { SLA_HOURS } from "../lib/sla-policy-service";
import { TICKET_PRIORITIES } from "../lib/ticket-rules";

const inputClass = "mt-1 rounded-xl2 border border-line bg-surface px-2 py-1 text-xs text-ink";

/** Which preset a stored policy was written on, read back off its calendar. */
export function hoursOf(policy: SlaPolicyRecord): SlaHours {
  return policy.calendar.name === "24x7" ? "always" : "business";
}

export function SlaPolicyForm({
  action,
  deleteAction,
  policy,
  clientId = null,
  queues = [],
}: {
  action: (formData: FormData) => Promise<void>;
  deleteAction?: (formData: FormData) => Promise<void>;
  policy?: SlaPolicyRecord;
  clientId?: string | null;
  /** The desk's queues, offered as a scope for a promise written for the desk. */
  queues?: { id: string; name: string }[];
}) {
  return (
    <div className="space-y-1.5 rounded-xl2 border border-line/70 bg-surface-muted/40 p-2.5">
      <form action={action} className="flex flex-wrap items-end gap-2">
        {policy ? <input type="hidden" name="policyId" value={policy.id} /> : null}
        {clientId ? <input type="hidden" name="clientId" value={clientId} /> : null}
        {/* A promise belongs to one owner. When the form is inside a client's
            card the client is the scope and this stays hidden; at desk level it
            is how a queue's own promise gets written. */}
        {!clientId && queues.length > 0 ? (
          <label className="text-xs text-ink-soft">
            Scope
            <select name="queueId" defaultValue={policy?.queueId ?? ""} className={`block ${inputClass}`}>
              <option value="">the whole desk</option>
              {queues.map((queue) => (
                <option key={queue.id} value={queue.id}>
                  {queue.name} only
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="text-xs text-ink-soft">
          Promise name
          <input
            name="name"
            required
            defaultValue={policy?.name ?? ""}
            placeholder="e.g. Northwind contract"
            className={`block ${inputClass}`}
          />
        </label>
        <label className="text-xs text-ink-soft">
          Priority
          <select name="priority" defaultValue={policy?.priority ?? ""} className={`block ${inputClass}`}>
            <option value="">any priority</option>
            {TICKET_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priority} only
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-soft">
          First response (minutes)
          <input
            name="responseMinutes"
            type="number"
            min={1}
            required
            defaultValue={policy?.responseMinutes ?? ""}
            className={`block w-28 ${inputClass}`}
          />
        </label>
        <label className="text-xs text-ink-soft">
          Resolution (minutes)
          <input
            name="resolutionMinutes"
            type="number"
            min={1}
            required
            defaultValue={policy?.resolutionMinutes ?? ""}
            className={`block w-28 ${inputClass}`}
          />
        </label>
        <label className="text-xs text-ink-soft">
          Hours
          <select name="hours" defaultValue={policy ? hoursOf(policy) : "business"} className={`block ${inputClass}`}>
            {SLA_HOURS.map((choice) => (
              <option key={choice.key} value={choice.key}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
          {policy ? "Save promise" : "Add promise"}
        </button>
      </form>

      {policy && deleteAction ? (
        <form action={deleteAction}>
          <input type="hidden" name="policyId" value={policy.id} />
          <button type="submit" className="text-[11px] text-pink hover:underline">
            Remove this promise
          </button>
        </form>
      ) : null}
    </div>
  );
}
