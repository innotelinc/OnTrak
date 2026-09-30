import { redirect } from "next/navigation";

import { requireActor } from "../../../lib/session";
import { actorHasPermission } from "../../../lib/access-rules";
import { macroServicesFor, prisma, slaPolicyServicesFor } from "../../../lib/db";
import { ACTION_KINDS, describeAction } from "../../../lib/rule-rules";
import type { MacroOverview } from "../../../lib/macro-service";
import { ruleValueOptions } from "../../../lib/rule-form-rules";
import { removeMacroAction, saveMacroAction, setMacroEnabledAction } from "../../actions/macros";

export const metadata = { title: "Macros" };

/**
 * The macro console (M5).
 *
 * A macro is a shortcut an agent runs on the ticket in front of them — the
 * deliberate counterpart to a rule, which fires on a trigger with nobody asking.
 * This screen answers the two questions a desk has about one:
 *
 *  1. **"What does it do?"** — the actions are read back as sentences rather than
 *     as the rows they were typed in, and the hazards are said out loud, because
 *     a macro that replies to the customer or pages the on-call does so the
 *     instant somebody clicks it.
 *  2. **"Who changed it?"** — writing, switching and removing are `rule:manage`
 *     and land on the audit chain with the macro's whole body. Running one is an
 *     agent's ordinary work, on the ticket, under `ticket:update`.
 *
 * Reading the library is `ticket:read:any`: an agent who cannot see what a
 * shortcut will do is an agent who cannot explain the ticket it changed.
 */
const ACTION_LABEL: Record<(typeof ACTION_KINDS)[number], string> = {
  set_priority: "Set the priority (URGENT, HIGH, NORMAL, LOW)",
  set_type: "Set the type (INCIDENT, REQUEST)",
  route_queue: "Route to the queue (id)",
  assign_agent: "Assign to the agent (id)",
  add_tag: "Add the tag",
  notify: "Notify staff with",
  reply: "Reply to the customer with",
  escalate: "Escalate with the reason",
};

const inputClass = "rounded-xl2 border border-line bg-surface px-2 py-1 text-sm text-ink";

/** One macro: what it is, what it does, and what can be done to it. */
function MacroCard({ entry, canManage }: { entry: MacroOverview; canManage: boolean }) {
  const { macro, hazards } = entry;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">{macro.name}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            macro.enabled ? "bg-ok/10 text-ok" : "bg-surface-muted text-ink-faint"
          }`}
        >
          {macro.enabled ? "available" : "retired"}
        </span>
        {canManage ? (
          <span className="ml-auto flex flex-wrap items-center gap-2 text-xs font-semibold">
            <a href={`/macros?edit=${macro.id}`} className="text-brand hover:underline">
              Edit
            </a>
            <form action={setMacroEnabledAction}>
              <input type="hidden" name="macroId" value={macro.id} />
              <input type="hidden" name="enabled" value={macro.enabled ? "false" : "true"} />
              <button type="submit" className="text-ink-soft hover:text-brand">
                {macro.enabled ? "Retire" : "Restore"}
              </button>
            </form>
            <form action={removeMacroAction}>
              <input type="hidden" name="macroId" value={macro.id} />
              <button type="submit" className="text-bad hover:underline">
                Remove
              </button>
            </form>
          </span>
        ) : null}
      </div>

      {macro.description ? <p className="mt-1.5 text-sm text-ink-soft">{macro.description}</p> : null}
      <ul className="mt-1 space-y-0.5 text-sm text-ink-soft">
        {macro.actions.map((action, index) => (
          <li key={`${action.kind}-${index}`}>
            <span className="font-semibold text-ink">Then </span>
            {describeAction(action)}
          </li>
        ))}
      </ul>

      {hazards.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-xs text-attention">
          {hazards.map((hazard) => (
            <li key={hazard}>⚠ {hazard}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default async function MacrosPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string; edit?: string }>;
}) {
  const actor = await requireActor();
  if (!actorHasPermission(actor, "ticket:read:any")) redirect("/portal");

  const { flash, error, edit } = await searchParams;
  const canManage = actorHasPermission(actor, "rule:manage");

  const listed = await macroServicesFor().list(actor);
  const macros = listed.ok ? listed.value : [];
  const listError = listed.ok ? null : listed.error;
  const editing = edit ? (macros.find((entry) => entry.macro.id === edit)?.macro ?? null) : null;

  // The queues and people a macro may point at, for the value datalist. Only
  // loaded for someone who can write one.
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
  const valueOptions = ruleValueOptions({ queues: queueResult?.ok ? queueResult.value : [], agents: staff });

  // The form offers one row per action the engine allows, so a shortcut is never
  // silently trimmed to what the page happened to render.
  const actionRows = editing ? Math.max(editing.actions.length, 2) : 2;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Macros</h1>
        <p className="text-sm text-ink-soft">
          Shortcuts an agent runs on a ticket in front of them — the deliberate counterpart to a rule, which fires on
          its own. A macro carries no conditions: if it needs one, it is a rule. One click applies every action below,
          in order, where the first action to set a field is the one that owns it.
        </p>
      </div>

      {flash ? <p className="rounded-xl2 border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">{flash}</p> : null}
      {error ?? listError ? (
        <p role="alert" className="rounded-xl2 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {error ?? listError}
        </p>
      ) : null}

      {macros.length === 0 ? (
        <p className="rounded-xl2 border border-line bg-surface p-5 text-sm text-ink-soft">
          No macros yet. Until one is written an agent repeats the same steps by hand.
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">
          {macros.map((entry) => (
            <MacroCard key={entry.macro.id} entry={entry} canManage={canManage} />
          ))}
        </ul>
      )}

      {canManage ? (
        <form action={saveMacroAction} className="space-y-4 rounded-xl2 border border-line bg-surface p-4">
          <h2 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">
            {editing ? `Edit “${editing.name}”` : "Add a macro"}
          </h2>
          {editing ? <input type="hidden" name="macroId" value={editing.id} /> : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">Name</span>
              <input
                name="name"
                required
                defaultValue={editing?.name ?? ""}
                className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">What it is for</span>
              <input
                name="description"
                defaultValue={editing?.description ?? ""}
                className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
              />
            </label>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-ink">Then do all of these, in order</legend>
            <p className="text-xs text-ink-faint">
              Leave a row blank to ignore it. A queue or an agent goes in by id — pick one from the list, or type a
              priority, a type or a tag.
            </p>
            {Array.from({ length: actionRows }, (_, row) => {
              const action = editing?.actions[row];
              return (
                <div key={row} className="flex flex-wrap items-center gap-2">
                  <select
                    name="actionKind"
                    defaultValue={action?.kind ?? ""}
                    aria-label={`Action ${row + 1}`}
                    className={inputClass}
                  >
                    <option value="">—</option>
                    {ACTION_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {ACTION_LABEL[kind]}
                      </option>
                    ))}
                  </select>
                  <input
                    name="actionValue"
                    list="macro-values"
                    defaultValue={action?.value ?? ""}
                    aria-label={`Action ${row + 1} value`}
                    className={`flex-1 ${inputClass}`}
                  />
                </div>
              );
            })}
          </fieldset>

          <datalist id="macro-values">
            {valueOptions.map((option) => (
              <option key={`${option.value}-${option.label ?? ""}`} value={option.value}>
                {option.label ?? option.value}
              </option>
            ))}
          </datalist>

          <div className="flex items-center gap-3">
            <button type="submit" className="rounded-full bg-brand px-4 py-2 text-xs font-semibold text-brand-ink">
              {editing ? "Save macro" : "Add macro"}
            </button>
            {editing ? (
              <a href="/macros" className="text-xs font-semibold text-ink-soft hover:text-brand">
                Cancel
              </a>
            ) : null}
          </div>
        </form>
      ) : (
        <p className="text-xs text-ink-faint">You can read the desk&rsquo;s macros; managing them is a manager&rsquo;s job.</p>
      )}
    </div>
  );
}
