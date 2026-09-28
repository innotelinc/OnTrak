import { redirect } from "next/navigation";

import { requireActor } from "../../../lib/session";
import { hasPermission } from "../../../lib/access-rules";
import {
  clientBrandingServicesFor,
  clientServicesFor,
  clientSurveyServicesFor,
  prisma,
  slaPolicyStoreFor,
  slaPolicyServicesFor,
  timeServicesFor,
} from "../../../lib/db";
import { clientSurveyAnswered, clientSurveyStatus } from "../../../lib/client-survey-rules";
import { satisfactionLabel } from "../../../lib/csat-rules";
import { resolveSlaPolicy } from "../../../lib/sla-rules";
import { describeScope } from "../../../lib/sla-policy-service";
import { formatMoney } from "../../../lib/time-rules";
import { brandFor, brandingSummary } from "../../../lib/client-branding-rules";
import { formatRate, retainerSummary } from "../../../lib/billing-rules";
import type { TicketPriority } from "../../../lib/ticket-rules";
import { SlaPolicyForm } from "../../../components/SlaPolicyForm";
import { RateCardForm } from "../../../components/RateCardForm";
import { BrandingForm, RetainerForm, TaxRuleForm } from "../../../components/ClientBilling";
import {
  addContactAction,
  assignClientAction,
  createClientAction,
  endActAsAction,
  startActAsAction,
  unassignClientAction,
} from "../../actions/clients";
import { deleteSlaPolicyAction, saveSlaPolicyAction } from "../../actions/sla";
import { removeRateCardAction, saveRateCardAction } from "../../actions/time";
import { requestClientSurveyAction } from "../../actions/surveys";
import { saveBrandingAction } from "../../actions/branding";
import { removeTaxRuleAction, saveRetainerAction, saveTaxRuleAction } from "../../actions/billing";

export const metadata = { title: "Clients" };

const inputClass = "mt-1 rounded-xl2 border border-line bg-surface px-3 py-1.5 text-sm text-ink";

/** The priorities a promise is stated at, so the ladder is visible at a glance. */
const SHOWN_PRIORITIES: readonly TicketPriority[] = ["URGENT", "HIGH", "NORMAL"];

/**
 * The multi-client console (M4): who the desk serves, who at the desk serves
 * them, and the promise each client has — with the scope that decides what a
 * reader sees, said out loud rather than left implicit.
 */
export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const actor = await requireActor();
  if (!hasPermission(actor.role, "ticket:read:any")) redirect("/portal");

  const { flash, error } = await searchParams;
  const service = clientServicesFor();
  const canManage = hasPermission(actor.role, "client:manage");

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const monthAgo = new Date(Date.parse(`${today}T00:00:00.000Z`) - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [overview, scope, policies, active, staff, cards, surveys, queues] = await Promise.all([
    service.list(actor),
    service.scope(actor),
    slaPolicyStoreFor().listForTenant(actor.tenantId),
    service.activeActAs(actor),
    canManage
      ? prisma.user.findMany({
          where: { tenantId: actor.tenantId, active: true, role: { in: ["ADMIN", "DISPATCHER", "AGENT"] } },
          select: { id: true, displayName: true, role: true },
          orderBy: { displayName: "asc" },
        })
      : Promise.resolve([]),
    timeServicesFor().rateCards(actor),
    clientSurveyServicesFor().all(actor),
    slaPolicyServicesFor().deskQueues(actor),
  ]);

  // The queues, so a promise written at desk level can be scoped to one of them
  // rather than only to everybody.
  const deskQueues = queues.ok ? queues.value : [];

  const clients = overview.ok ? overview.value : [];
  const staffNames = new Map(staff.map((person) => [person.id, person.displayName]));
  // Promises the desk wrote for itself, as opposed to ones it promised a client.
  // Both are editable here; the ladder above each client decides which wins.
  const deskPolicies = policies.filter((policy) => !policy.clientId);
  const rateCards = cards.ok ? cards.value : [];
  const cardOf = (clientId: string | null) => rateCards.find((card) => card.clientId === clientId);
  const deskCard = cardOf(null);
  const allSurveys = surveys.ok ? surveys.value : [];

  // Branding, tax rules and retainers are per client, so they are read per
  // client here rather than by the list endpoint: a console that showed every
  // client's brand to an agent scoped to two of them would leak the rest.
  const [brandingViews, taxRules, retainerViews] = await Promise.all([
    clientBrandingServicesFor().list(actor),
    timeServicesFor().taxRules(actor),
    Promise.all(
      clients.map(async (entry) => [entry.client.id, await timeServicesFor().retainers(actor, entry.client.id)] as const),
    ),
  ]);
  const brandingByClient = new Map((brandingViews.ok ? brandingViews.value : []).map((view) => [view.clientId, view.branding]));
  const brandingOf = (clientId: string) => brandingByClient.get(clientId) ?? null;
  const taxRulesAll = taxRules.ok ? taxRules.value : [];
  const taxOf = (clientId: string) => taxRulesAll.find((rule) => rule.clientId === clientId) ?? null;
  const deskTax = taxRulesAll.find((rule) => !rule.clientId) ?? null;
  const retainersByClient = new Map(retainerViews.map(([clientId, result]) => [clientId, result.ok ? result.value : []]));
  const retainersOf = (clientId: string) => retainersByClient.get(clientId) ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Clients</h1>
        <p className="text-sm text-ink-soft">
          {clients.length === 0
            ? "No clients yet."
            : `${clients.length} client${clients.length === 1 ? "" : "s"} in your scope — ${scope.because}.`}
        </p>
        {scope.kind === "assigned" ? (
          <p className="text-xs text-ink-faint">
            Work with no client recorded stays visible to everybody, because it belongs to the desk rather than to a client.
          </p>
        ) : null}
      </div>

      {flash ? (
        <p className="rounded-xl2 border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">{flash}</p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
          {error}
        </p>
      ) : null}

      {active ? (
        <section className="space-y-2 rounded-xl2 border border-amber/40 bg-amber/10 p-4">
          <h2 className="text-sm font-semibold text-amber">
            Acting as {clients.find((entry) => entry.client.id === active.clientId)?.client.name ?? active.clientId}
          </h2>
          <p className="text-xs text-ink-soft">
            Since {active.startedAt}, until {active.expiresAt} — because: {active.reason}. This window is on the record twice:
            as a row, and as an audit event with the reason.
          </p>
          <form action={endActAsAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="sessionId" value={active.id} />
            <label className="text-xs text-ink-soft">
              Why it is ending (optional)
              <input name="endReason" placeholder="done looking" className={`block ${inputClass}`} />
            </label>
            <button type="submit" className="rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-white">
              Stop acting as the client
            </button>
          </form>
        </section>
      ) : null}

      {clients.length > 0 ? (
        <ul className="space-y-3">
          {clients.map(({ client, contacts, assignments }) => {
            const card = cardOf(client.id);
            return (
            <li key={client.id} className="space-y-3 rounded-xl2 border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold text-ink">{client.name}</h2>
                <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
                  {contacts.length} contact{contacts.length === 1 ? "" : "s"}
                </span>
                <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
                  {assignments.length} assigned
                </span>
                <span className="ml-auto text-[11px] text-ink-faint">added {client.createdAt.slice(0, 10)}</span>
              </div>

              {/* The promise, and which rung of the ladder answered. */}
              <ul className="space-y-0.5">
                {SHOWN_PRIORITIES.map((priority) => {
                  const resolution = resolveSlaPolicy({ policies, priority, clientId: client.id });
                  return (
                    <li key={priority} className="text-xs text-ink-soft">
                      <span className="font-semibold text-ink">{priority}</span>{" "}
                      {resolution.policy ? (
                        <>
                          {resolution.policy.responseMinutes}m to respond · {resolution.policy.resolutionMinutes}m to resolve{" "}
                          <span className="text-ink-faint">
                            (because {resolution.because}
                            {resolution.policy.name ? `: ${resolution.policy.name}` : ""})
                          </span>
                        </>
                      ) : (
                        <span className="text-ink-faint">no policy covers this priority</span>
                      )}
                    </li>
                  );
                })}
              </ul>

              {/* The promises written *for this client*, which the ladder above
                  picked up ahead of the desk's. Editable while the desk is here. */}
              {canManage ? (
                <div className="space-y-1.5">
                  {policies
                    .filter((policy) => policy.clientId === client.id)
                    .map((policy) => (
                      <SlaPolicyForm
                        key={policy.id}
                        action={saveSlaPolicyAction}
                        deleteAction={deleteSlaPolicyAction}
                        policy={policy}
                        clientId={client.id}
                      />
                    ))}
                  <SlaPolicyForm action={saveSlaPolicyAction} clientId={client.id} />
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {policies.filter((policy) => policy.clientId === client.id).length === 0 ? (
                    <li className="text-xs text-ink-faint">No promise has been written for this client yet.</li>
                  ) : (
                    policies
                      .filter((policy) => policy.clientId === client.id)
                      .map((policy) => (
                        <li key={policy.id} className="text-xs text-ink-soft">
                          <span className="font-semibold text-ink">{policy.name}</span> — {describeScope(policy)}
                        </li>
                      ))
                  )}
                </ul>
              )}

              {/* What the work costs. One card per client, replacing rather than
                  accumulating: two cards for one client is two prices for one hour. */}
              {canManage ? (
                <RateCardForm
                  action={saveRateCardAction}
                  removeAction={removeRateCardAction}
                  clientId={client.id}
                  {...(card ? { card } : {})}
                />
              ) : card ? (
                <p className="text-xs text-ink-soft">
                  Rate card: {card.name} — {formatMoney(card.hourlyRateCents, card.currency)}/hour
                </p>
              ) : (
                <p className="text-xs text-ink-faint">No rate card of their own; the desk&apos;s default applies.</p>
              )}

              {/* Whose colours and name this client is shown in. A client with no
                  brand of their own reads as the desk, which is stated rather
                  than left to be discovered on an invoice. */}
              {canManage ? (
                <BrandingForm
                  action={saveBrandingAction}
                  clientId={client.id}
                  clientName={client.name}
                  {...(brandingOf(client.id) ? { branding: brandingOf(client.id)! } : {})}
                />
              ) : (
                <p className="text-xs text-ink-soft">
                  Branding: {brandingSummary(brandFor({ name: client.name }, brandingOf(client.id)))}
                </p>
              )}

              {/* What is added to a bill, and what was paid before the work.
                  Tax is read here because it is a property of *who* is being
                  billed, exactly like the rate card above it. */}
              {canManage ? (
                <TaxRuleForm
                  action={saveTaxRuleAction}
                  removeAction={removeTaxRuleAction}
                  clientId={client.id}
                  {...(taxOf(client.id) ? { rule: taxOf(client.id)! } : {})}
                />
              ) : taxOf(client.id) ? (
                <p className="text-xs text-ink-soft">
                  Tax: {taxOf(client.id)!.label} at {formatRate(taxOf(client.id)!.rateBasisPoints)}
                </p>
              ) : (
                <p className="text-xs text-ink-faint">No tax rule of their own; the desk&apos;s default applies.</p>
              )}

              {canManage ? (
                <RetainerForm action={saveRetainerAction} clientId={client.id} currency={card?.currency ?? "USD"} />
              ) : null}
              {retainersOf(client.id).length > 0 ? (
                <ul className="space-y-0.5">
                  {retainersOf(client.id).map(({ retainer, standing }) => (
                    <li key={retainer.id} className="text-xs text-ink-soft">
                      <span className="font-semibold text-ink">Retainer</span> {retainerSummary(retainer, standing)}
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* What their people said, and the link that asks them. One question
                  per period: asking twice for the same month is how a client
                  learns to ignore the question. */}
              <div className="space-y-1.5">
                <p className="text-[11px] font-semibold text-ink-soft">Their own rating</p>
                {canManage ? (
                  <form action={requestClientSurveyAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="clientId" value={client.id} />
                    <label className="text-xs text-ink-soft">
                      Period start
                      <input name="periodStart" type="date" required defaultValue={monthAgo} className={`block ${inputClass}`} />
                    </label>
                    <label className="text-xs text-ink-soft">
                      Period end
                      <input name="periodEnd" type="date" required defaultValue={today} className={`block ${inputClass}`} />
                    </label>
                    <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
                      Ask for a rating
                    </button>
                  </form>
                ) : null}
                <ul className="space-y-0.5">
                  {allSurveys.filter((survey) => survey.clientId === client.id).length === 0 ? (
                    <li className="text-xs text-ink-faint">Nobody has been asked how this client&apos;s support went.</li>
                  ) : (
                    allSurveys
                      .filter((survey) => survey.clientId === client.id)
                      .map((survey) => {
                        const status = clientSurveyStatus(survey, now);
                        return (
                          <li key={survey.id} className="text-xs text-ink-soft">
                            <span className="font-mono text-[11px] text-ink-faint">
                              {survey.periodStart} → {survey.periodEnd}
                            </span>{" "}
                            {clientSurveyAnswered(survey) ? (
                              <>
                                <span className="font-semibold text-ink">
                                  {survey.score}/5 — {satisfactionLabel(survey.score as 1 | 2 | 3 | 4 | 5)}
                                </span>
                                {survey.comment ? <span className="text-ink-soft"> “{survey.comment}”</span> : null}
                              </>
                            ) : status === "pending" ? (
                              <>
                                awaiting an answer —{" "}
                                <a href={`/survey/${survey.token}`} className="text-brand hover:underline">
                                  open the link they were sent
                                </a>
                              </>
                            ) : (
                              <span className="text-amber">the link expired unanswered</span>
                            )}
                          </li>
                        );
                      })
                  )}
                </ul>
              </div>

              {contacts.length > 0 ? (
                <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line">
                  {contacts.map((contact) => (
                    <li key={contact.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
                      <span className="font-medium text-ink">{contact.name}</span>
                      <span className="text-ink-soft">{contact.email}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-ink-faint">No contact at this client yet — nothing to reply to.</p>
              )}

              {assignments.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-ink-faint">Served by:</span>
                  {assignments.map((assignment) => (
                    <span
                      key={assignment.id}
                      className="inline-flex items-center gap-2 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand"
                    >
                      {staffNames.get(assignment.userId) ?? assignment.userId}
                      {canManage ? (
                        <form action={unassignClientAction}>
                          <input type="hidden" name="clientId" value={client.id} />
                          <input type="hidden" name="userId" value={assignment.userId} />
                          <button type="submit" className="text-pink hover:underline">
                            remove
                          </button>
                        </form>
                      ) : null}
                    </span>
                  ))}
                </div>
              ) : null}

              {canManage ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <form action={addContactAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="clientId" value={client.id} />
                    <label className="text-xs text-ink-soft">
                      Contact name
                      <input name="name" required className={`block ${inputClass}`} />
                    </label>
                    <label className="text-xs text-ink-soft">
                      Email
                      <input name="email" type="email" required className={`block ${inputClass}`} />
                    </label>
                    <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
                      Add contact
                    </button>
                  </form>

                  <form action={assignClientAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="clientId" value={client.id} />
                    <label className="text-xs text-ink-soft">
                      Assign someone
                      <select name="userId" required defaultValue="" className={`block ${inputClass}`}>
                        <option value="">— choose a person —</option>
                        {staff.map((person) => (
                          <option key={person.id} value={person.id}>
                            {person.displayName} ({person.role})
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
                      Assign
                    </button>
                  </form>

                  <form action={startActAsAction} className="flex flex-wrap items-end gap-2 sm:col-span-2">
                    <input type="hidden" name="clientId" value={client.id} />
                    <label className="text-xs text-ink-soft">
                      Reason to act as this client
                      <input name="reason" required placeholder="e.g. reproduce the ticket they are complaining about" className={`block ${inputClass}`} />
                    </label>
                    <button type="submit" className="rounded-full border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink-soft">
                      Act as client
                    </button>
                  </form>
                </div>
              ) : null}
            </li>
            );
          })}
        </ul>
      ) : null}

      {canManage ? (
        <section aria-label="The desk's default tax rule" className="space-y-2 rounded-xl2 border border-line bg-surface p-4">
          <h2 className="font-display text-sm font-semibold text-ink">The desk&apos;s default tax</h2>
          <p className="text-xs text-ink-faint">
            Applied to an invoice for a client with no rule of their own, at the moment it is issued — so a rate changed
            later never restates what was already charged.
          </p>
          <TaxRuleForm
            action={saveTaxRuleAction}
            removeAction={removeTaxRuleAction}
            {...(deskTax ? { rule: deskTax } : {})}
          />
        </section>
      ) : null}

      <section aria-label="The desk's own promises" className="space-y-2 rounded-xl2 border border-line bg-surface p-4">
        <h2 className="font-display text-sm font-semibold text-ink">The desk&apos;s own promises</h2>
        <p className="text-xs text-ink-faint">
          {deskPolicies.length === 0
            ? "Nothing is written for the desk itself."
            : `${deskPolicies.length} promise${deskPolicies.length === 1 ? "" : "s"} apply to a client that has none of its own.`}
        </p>
        {deskPolicies.map((policy) =>
          canManage ? (
            <SlaPolicyForm
              key={policy.id}
              queues={deskQueues}
              action={saveSlaPolicyAction}
              deleteAction={deleteSlaPolicyAction}
              policy={policy}
            />
          ) : (
            <p key={policy.id} className="text-xs text-ink-soft">
              <span className="font-semibold text-ink">{policy.name}</span> — {describeScope(policy)} · {policy.calendar.name}
            </p>
          ),
        )}
        {canManage ? <SlaPolicyForm action={saveSlaPolicyAction} queues={deskQueues} /> : null}

        <h2 className="pt-2 font-display text-sm font-semibold text-ink">The desk&apos;s own rate card</h2>
        <p className="text-xs text-ink-faint">
          What time costs for a client without a card of their own, and for the desk&apos;s own work.
        </p>
        {canManage ? (
          <RateCardForm action={saveRateCardAction} removeAction={removeRateCardAction} {...(deskCard ? { card: deskCard } : {})} />
        ) : deskCard ? (
          <p className="text-xs text-ink-soft">
            {deskCard.name} — {formatMoney(deskCard.hourlyRateCents, deskCard.currency)}/hour
          </p>
        ) : null}
      </section>

      {canManage ? (
        <form action={createClientAction} className="flex flex-wrap items-end gap-2 rounded-xl2 border border-line bg-surface p-4">
          <label className="text-sm font-medium text-ink">
            New client
            <input name="name" required placeholder="e.g. Northwind Logistics" className={`block ${inputClass}`} />
          </label>
          <button type="submit" className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white">
            Add client
          </button>
          <p className="w-full text-xs text-ink-faint">
            A client's own policies are picked up by the SLA ladder ahead of the queue's and the desk's, and being assigned to a
            client is what puts its work in scope.
          </p>
        </form>
      ) : (
        <p className="rounded-xl2 border border-line bg-surface p-4 text-sm text-ink-soft">
          You can see the clients in your scope but not change them.
        </p>
      )}
    </div>
  );
}
