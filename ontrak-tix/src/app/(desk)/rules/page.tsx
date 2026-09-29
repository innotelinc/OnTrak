import { redirect } from "next/navigation";

import { requireActor } from "../../../lib/session";
import { hasPermission } from "../../../lib/access-rules";
import { prisma, ruleServicesFor, slaPolicyServicesFor, ticketServicesFor } from "../../../lib/db";
import {
  ACTION_KINDS,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  describeAction,
  describeCondition,
  isRuleTrigger,
  RULE_TRIGGERS,
  type ActionKind,
  type ConditionField,
  type ConditionOperator,
  type DryRunReport,
  type RuleTicketView,
  type RuleTrigger,
} from "../../../lib/rule-rules";
import type { RuleOverview } from "../../../lib/rule-service";
import { ruleValueOptions } from "../../../lib/rule-form-rules";
import { ruleViewOf } from "../../../lib/rule-intake";
import { createRuleAction, moveRuleAction, removeRuleAction, setRuleEnabledAction } from "../../actions/rules";

export const metadata = { title: "Rules" };

/**
 * The automation console (M5).
 *
 * A rule is configuration that acts on every future ticket, so this screen is
 * built around two questions a desk actually asks, in this order:
 *
 *  1. **"What would this do?"** — every rule has a preview, and a preview of a
 *     *switched-off* rule runs it as if it were on, because that is the moment
 *     the question is asked. The dry run is the same engine the live path uses,
 *     over the last {PREVIEW_LIMIT} tickets, so the answer is not an estimate.
 *  2. **"Who decided that?"** — the conditions and actions are read back as
 *     sentences rather than as the rows they were typed in, the hazards are said
 *     out loud instead of left to be discovered from a customer's reply, and the
 *     order the rules run in is visible and changeable, because the first rule to
 *     set a field is the one that owns it.
 *
 * Reading the rules is `ticket:read:any` — an agent who cannot see why a ticket
 * arrived urgent is an agent who cannot explain it to the customer. Writing,
 * moving, switching and removing them is `rule:manage`.
 */
const PREVIEW_LIMIT = 50;

const TRIGGER_LABEL: Record<RuleTrigger, string> = {
  "ticket.created": "when a ticket is created",
  "ticket.updated": "when a ticket changes",
  "ticket.replied": "when somebody replies",
};

const FIELD_LABEL: Record<ConditionField, string> = {
  subject: "the subject",
  description: "the description",
  type: "the type",
  priority: "the priority",
  status: "the status",
  queueId: "the queue",
  clientId: "the client",
  requesterEmail: "the requester's address",
  tag: "a tag",
};

const OPERATOR_LABEL: Record<ConditionOperator, string> = {
  contains: "contains",
  not_contains: "does not contain",
  equals: "is",
  not_equals: "is not",
  is_one_of: "is one of",
  is_not_one_of: "is none of",
  is_empty: "is empty",
  is_not_empty: "is not empty",
};

const ACTION_LABEL: Record<ActionKind, string> = {
  set_priority: "Set the priority to",
  set_type: "Set the type to",
  route_queue: "Route it to the queue",
  assign_agent: "Assign it to the agent",
  add_tag: "Tag it",
  notify: "Notify staff:",
  reply: "Reply to the customer:",
  escalate: "Escalate with the reason",
};

const inputClass = "rounded-xl2 border border-line bg-surface px-2 py-1 text-sm text-ink";

/**
 * The tickets a preview runs over: the most recent ones, with the requester's
 * address resolved, because a rule may match on it and a preview that could not
 * see it would under-report what the rule does.
 */
async function previewTickets(tenantId: string): Promise<(RuleTicketView & { id: string })[]> {
  const all = await ticketServicesFor().store.listTickets(tenantId);
  const recent = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, PREVIEW_LIMIT);
  const requesterIds = [...new Set(recent.map((ticket) => ticket.requesterId))];
  const people =
    requesterIds.length > 0
      ? await prisma.user.findMany({ where: { tenantId, id: { in: requesterIds } }, select: { id: true, email: true } })
      : [];
  const email = new Map(people.map((person) => [person.id, person.email]));
  return recent.map((ticket) => ({ ...ruleViewOf(ticket, email.get(ticket.requesterId) ?? null), id: ticket.id }));
}

/** One rule: what it is, what it does, and what can be done to it. */
function RuleCard({ entry, canManage, previewed }: { entry: RuleOverview; canManage: boolean; previewed: boolean }) {
  const { rule, hazards } = entry;
  const conditions =
    rule.conditions.length === 0
      ? "Matches every ticket this trigger sees."
      : `Matches ${rule.conditions.map((condition) => describeCondition(condition)).join(", and ")}.`;

  return (
    <li className={`px-4 py-3 ${previewed ? "bg-brand-soft/40" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-soft">#{rule.position}</span>
        <span className="font-semibold text-ink">{rule.name}</span>
        <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand">
          {TRIGGER_LABEL[rule.trigger]}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            rule.enabled ? "bg-teal/10 text-teal" : "bg-surface-muted text-ink-faint"
          }`}
        >
          {rule.enabled ? "on" : "off"}
        </span>
        {canManage ? (
          <span className="ml-auto flex flex-wrap items-center gap-2 text-xs font-semibold">
            <a href={`/rules?rule=${rule.id}`} className="text-brand hover:underline">
              Preview
            </a>
            <form action={moveRuleAction}>
              <input type="hidden" name="ruleId" value={rule.id} />
              <button type="submit" name="direction" value="up" className="text-ink-soft hover:text-brand">
                Move up
              </button>
            </form>
            <form action={moveRuleAction}>
              <input type="hidden" name="ruleId" value={rule.id} />
              <button type="submit" name="direction" value="down" className="text-ink-soft hover:text-brand">
                Move down
              </button>
            </form>
            <form action={setRuleEnabledAction}>
              <input type="hidden" name="ruleId" value={rule.id} />
              <input type="hidden" name="enabled" value={rule.enabled ? "false" : "true"} />
              <button type="submit" className="text-ink-soft hover:text-brand">
                {rule.enabled ? "Switch off" : "Switch on"}
              </button>
            </form>
            <form action={removeRuleAction}>
              <input type="hidden" name="ruleId" value={rule.id} />
              <button type="submit" className="text-pink hover:underline">
                Remove
              </button>
            </form>
          </span>
        ) : null}
      </div>

      <p className="mt-1.5 text-sm text-ink-soft">{conditions}</p>
      {rule.actions.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-sm text-ink-soft">
          {rule.actions.map((action, index) => (
            <li key={`${action.kind}-${index}`}>
              <span className="font-semibold text-ink">Then </span>
              {ACTION_LABEL[action.kind]}
              {action.value && action.kind !== "add_tag" ? ` ${action.value}` : action.value ? ` “${action.value}”` : ""}
              {!action.value && action.kind === "escalate" ? " (no reason given)" : ""}
            </li>
          ))}
        </ul>
      ) : null}

      {hazards.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-xs text-amber">
          {hazards.map((hazard) => (
            <li key={hazard}>⚠ {hazard}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The dry-run table: what each ticket the rules touched would become. */
function PreviewPanel({ report, title, note }: { report: DryRunReport; title: string; note: string }) {
  return (
    <section aria-label="Dry run" className="space-y-3 rounded-xl2 border border-brand/40 bg-brand-soft/30 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-sm font-semibold text-ink">{title}</h2>
        <span className="text-xs text-ink-soft">
          {report.touched} of {report.touched + report.untouched} recent tickets matched
        </span>
        <a href="/rules" className="ml-auto text-xs font-semibold text-brand hover:underline">
          Close preview
        </a>
      </div>
      <p className="text-xs text-ink-faint">{note}</p>

      {report.tickets.length === 0 ? (
        <p className="text-sm text-ink-soft">Nothing in the recent tickets matches, so this changes nothing today.</p>
      ) : (
        <ul className="space-y-2">
          {report.tickets.map((ticket) => (
            <li key={ticket.ticketId} className="rounded-xl2 border border-line bg-surface px-3 py-2">
              <p className="text-sm font-semibold text-ink">{ticket.subject}</p>
              <p className="text-xs text-ink-faint">Matched: {ticket.matched.map((rule) => rule.ruleName).join(", ")}</p>
              <ul className="mt-1 space-y-0.5 text-xs text-ink-soft">
                {ticket.plan.applied.map((applied, index) => (
                  <li key={`${applied.ruleId}-${applied.action.kind}-${index}`}>
                    {describeAction(applied.action)}{" "}
                    <span className="text-ink-faint">by “{applied.ruleName}”</span>
                  </li>
                ))}
                {ticket.plan.skipped.map((skipped, index) => (
                  <li key={`skip-${skipped.ruleId}-${index}`} className="text-amber">
                    Skipped: {describeAction(skipped.action)} — {skipped.because}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function RulesPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string; rule?: string; trigger?: string }>;
}) {
  const actor = await requireActor();
  if (!hasPermission(actor.role, "ticket:read:any")) redirect("/portal");

  const { flash, error, rule: ruleId, trigger } = await searchParams;
  const canManage = hasPermission(actor.role, "rule:manage");

  const listed = await ruleServicesFor().list(actor);
  const rules = listed.ok ? listed.value : [];
  const listError = listed.ok ? null : listed.error;

  const [queueResult, staff] = canManage
    ? await Promise.all([
        slaPolicyServicesFor().deskQueues(actor),
        prisma.user.findMany({
          where: { tenantId: actor.tenantId, active: true, role: { in: ["ADMIN", "DISPATCHER", "AGENT"] } },
          select: { id: true, displayName: true },
          orderBy: { displayName: "asc" },
        }),
      ])
    : [null, []];
  const deskQueues = queueResult?.ok ? queueResult.value : [];
  const valueOptions = ruleValueOptions({ queues: deskQueues, agents: staff });

  // A preview is a question about configuration, so it needs `rule:manage`; the
  // trigger variant runs the whole ruleset as it stands, the rule variant runs
  // one rule as if it were switched on.
  const previewTrigger = trigger && isRuleTrigger(trigger) ? trigger : null;
  let report: DryRunReport | null = null;
  let previewedRuleId: string | null = null;
  let previewTitle = "";
  let previewError: string | null = null;

  if (canManage && (ruleId || previewTrigger)) {
    const tickets = await previewTickets(actor.tenantId);
    if (ruleId) {
      const result = await ruleServicesFor().previewRule(actor, ruleId, tickets);
      if (result.ok) {
        report = result.value;
        previewedRuleId = ruleId;
        previewTitle = `Dry run: “${rules.find((entry) => entry.rule.id === ruleId)?.rule.name ?? "rule"}”`;
      } else {
        previewError = result.error;
      }
    } else if (previewTrigger) {
      const result = await ruleServicesFor().preview(actor, tickets, previewTrigger);
      if (result.ok) {
        report = result.value;
        previewTitle = `Dry run: every rule that runs ${TRIGGER_LABEL[previewTrigger]}`;
      } else {
        previewError = result.error;
      }
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Rules</h1>
        <p className="text-sm text-ink-soft">
          What the desk does by itself when a ticket arrives. Conditions are all required — there is no “or”, because
          “which rule did this?” should have one answer — and the rules run in the order below, where the first one to
          set a field is the one that owns it.
        </p>
      </div>

      {flash ? <p className="rounded-xl2 border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">{flash}</p> : null}
      {error ?? listError ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
          {error ?? listError}
        </p>
      ) : null}
      {previewError ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
          {previewError}
        </p>
      ) : null}

      {report ? (
        <PreviewPanel
          report={report}
          title={previewTitle}
          note={`Run over the last ${PREVIEW_LIMIT} tickets with the same engine the live path uses, and nothing was written. A switched-off rule is previewed as if it were switched on.`}
        />
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-ink-soft">Dry-run every enabled rule:</span>
          {RULE_TRIGGERS.map((entry) => (
            <a
              key={entry}
              href={`/rules?trigger=${entry}`}
              className="rounded-full border border-line bg-surface px-3 py-1 font-semibold text-ink-soft hover:border-brand/40 hover:text-brand"
            >
              {TRIGGER_LABEL[entry]}
            </a>
          ))}
        </div>
      ) : null}

      {rules.length === 0 ? (
        <p className="rounded-xl2 border border-line bg-surface p-5 text-sm text-ink-soft">
          No rules yet. Until one is written the desk files everything by hand.
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">
          {rules.map((entry) => (
            <RuleCard key={entry.rule.id} entry={entry} canManage={canManage} previewed={entry.rule.id === previewedRuleId} />
          ))}
        </ul>
      )}

      {canManage ? (
        <form action={createRuleAction} className="space-y-4 rounded-xl2 border border-line bg-surface p-4">
          <h2 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">Add a rule</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">Name</span>
              <input name="name" required className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">Runs</span>
              <select name="trigger" defaultValue="ticket.created" className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink">
                {RULE_TRIGGERS.map((entry) => (
                  <option key={entry} value={entry}>
                    {TRIGGER_LABEL[entry]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-ink">When all of these hold</legend>
            <p className="text-xs text-ink-faint">
              Leave a row blank to ignore it. “is one of” takes a comma-separated list. A queue or an agent goes in by id —
              pick one from the list, or type a priority, a type or a tag.
            </p>
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex flex-wrap items-center gap-2">
                <select name="conditionField" defaultValue="" aria-label={`Condition ${row + 1} field`} className={inputClass}>
                  <option value="">—</option>
                  {CONDITION_FIELDS.map((field) => (
                    <option key={field} value={field}>
                      {FIELD_LABEL[field]}
                    </option>
                  ))}
                </select>
                <select name="conditionOperator" defaultValue="" aria-label={`Condition ${row + 1} comparison`} className={inputClass}>
                  <option value="">—</option>
                  {CONDITION_OPERATORS.map((operator) => (
                    <option key={operator} value={operator}>
                      {OPERATOR_LABEL[operator]}
                    </option>
                  ))}
                </select>
                <input
                  name="conditionValue"
                  list="rule-values"
                  aria-label={`Condition ${row + 1} value`}
                  className={`flex-1 ${inputClass}`}
                />
              </div>
            ))}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-ink">Then do all of these</legend>
            {[0, 1].map((row) => (
              <div key={row} className="flex flex-wrap items-center gap-2">
                <select name="actionKind" defaultValue="" aria-label={`Action ${row + 1}`} className={inputClass}>
                  <option value="">—</option>
                  {ACTION_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {ACTION_LABEL[kind]}
                    </option>
                  ))}
                </select>
                <input
                  name="actionValue"
                  list="rule-values"
                  aria-label={`Action ${row + 1} value`}
                  className={`flex-1 ${inputClass}`}
                />
              </div>
            ))}
          </fieldset>

          <datalist id="rule-values">
            {valueOptions.map((option) => (
              <option key={`${option.value}-${option.label ?? ""}`} value={option.value}>
                {option.label ?? option.value}
              </option>
            ))}
          </datalist>

          <p className="text-xs text-ink-faint">
            A new rule runs last, so adding one cannot change what the rules already in place do. Preview it before
            switching it on.
          </p>

          <button type="submit" className="rounded-full bg-brand px-4 py-2 text-xs font-semibold text-brand-ink">
            Save rule
          </button>
        </form>
      ) : (
        <p className="text-xs text-ink-faint">You can read the desk&rsquo;s rules; managing them is a manager&rsquo;s job.</p>
      )}
    </div>
  );
}
