/**
 * RMM / monitoring connector (M6): a check goes down, a ticket opens, the check
 * recovers, the ticket closes.
 *
 * `rmm-rules.ts` decides everything; this file carries the decision out and writes
 * the three things that must outlive the request — the link between a condition and
 * its ticket, the notes on the thread, and a hash-chained audit event. Five choices
 * worth stating out loud:
 *
 *  - **Work is raised through `TicketService`, on the system's behalf.** The very
 *    same `createTicket` a person's request goes through, so a monitoring ticket
 *    fires the desk's rules, lands on the tenant's hash chain and appears in the
 *    inbox exactly like any other — there is no privileged back door, which is the
 *    reason `alert-promotion-service.ts` is built the same way.
 *  - **The link is written after the ticket, and it is what makes the clear work.**
 *    The condition's key is the lookup, so a recovery that arrives with a different
 *    vendor alert id still finds the ticket it belongs to. Without the link, a
 *    recovery is indistinguishable from a first sighting.
 *  - **A repeat is a note, not a second ticket.** Vendors retry, and a check that
 *    fails every minute for an hour is one outage; opening sixty tickets for it is
 *    how a desk stops trusting automation.
 *  - **The clear walks the lifecycle's own edges.** `NEW → OPEN → CLOSED` rather
 *    than a shortcut, because `ticket-rules.ts` forbids the jump and because an
 *    auto-closed ticket should leave the trail a person's would.
 *  - **The requester is the desk's, not the vendor's.** A monitoring alert has no
 *    requester, so one is injected per tenant. If there is none to raise work for,
 *    the answer is `503` — a configuration problem the sender should retry after,
 *    rather than a `500` that hides it among transient failures.
 *
 * The ticket stack and the requester resolver are injected whole, so this module
 * has no Prisma import and its rules are tested without a database.
 */

import { randomUUID } from "node:crypto";

import type { Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  closePath,
  decideRmmAction,
  needsClosing,
  parseRmmAlert,
  repeatNote,
  resolutionNote,
  rmmTicketDraft,
  worstSeverity,
  type RmmAlertEvent,
  type RmmIntakeOutcome,
  type RmmLinkRecord,
} from "./rmm-rules";
import type { ServiceResult, TicketRecord, TicketService } from "./ticket-service";

/** The system actor a monitoring connector writes as. A normal ADMIN, on purpose. */
export const SYSTEM_RMM_ACTOR = "system:rmm-connector";

/** The actor a monitoring connector runs as, scoped to the tenant it acts for. */
export function rmmActor(tenantId: string): Actor {
  return { id: SYSTEM_RMM_ACTOR, tenantId, role: "ADMIN" };
}

/* -------------------------------------------------------------------------- */
/*  The ports                                                                 */
/* -------------------------------------------------------------------------- */

export interface RmmStore {
  /** The condition's link, if this desk has ever worked it. */
  findLink(tenantId: string, dedupeKey: string): Promise<RmmLinkRecord | null>;
  findLinkByTicket(tenantId: string, ticketId: string): Promise<RmmLinkRecord | null>;
  listLinks(tenantId: string): Promise<RmmLinkRecord[]>;
  insertLink(record: RmmLinkRecord): Promise<void>;
  updateLink(record: RmmLinkRecord): Promise<void>;
}

export interface RmmIds {
  id(): string;
  now(): string;
  nowMs(): number;
}

export function systemRmmIds(): RmmIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString(), nowMs: () => Date.now() };
}

/**
 * What the connector needs of the rest of the product.
 *
 * `tickets` is the ticket service plus one read from its store, exactly as the
 * alert-promotion service takes it: the `findTicket` is needed because closing a
 * ticket has to know what state it is in before choosing an edge to walk.
 */
export interface RmmDeps {
  tickets: Pick<TicketService, "createTicket" | "setStatus" | "reply"> & {
    findTicket(tenantId: string, ticketId: string): Promise<TicketRecord | null>;
  };
  /**
   * Who a monitoring ticket is raised for. A monitoring alert has no requester of
   * its own, so the desk answers — the tenant's monitoring mailbox, or its first
   * administrator. `null` means there is nobody, which is a `503`.
   */
  requesterFor(tenantId: string): Promise<string | null>;
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

export class RmmConnectorService {
  constructor(
    private readonly store: RmmStore,
    private readonly deps: RmmDeps,
    private readonly audit: AuditSink | null = null,
    private readonly ids: RmmIds = systemRmmIds(),
  ) {}

  /**
   * Take one monitoring webhook and do whatever the condition calls for.
   *
   * Total by design: every input produces an outcome a route can turn into a status
   * code, and nothing here throws. A vendor's malformed payload, a test's stubbed
   * failure and a desk with nobody to raise work for are all answers, not crashes —
   * an inbound webhook that throws is one the sender retries forever.
   */
  async receive(tenantId: string, body: unknown): Promise<RmmIntakeOutcome> {
    const event = parseRmmAlert(body, this.ids.now());
    if (!event) {
      return {
        kind: "rejected",
        reason: "Payload was not a monitoring alert: it needs a host, a check and a state.",
      };
    }

    const link = await this.store.findLink(tenantId, event.dedupeKey);
    const decision = decideRmmAction(event, link);
    const actor = rmmActor(tenantId);

    try {
      switch (decision.action) {
        case "OPEN":
          return await this.open(tenantId, event, actor);
        case "REOPEN":
          return await this.reopen(tenantId, event, link as RmmLinkRecord, actor, decision.reason);
        case "REPEAT":
          return await this.repeat(tenantId, event, link as RmmLinkRecord, actor);
        case "RESOLVE":
          return await this.resolve(tenantId, event, link as RmmLinkRecord, actor, decision.reason);
        case "IGNORE":
          return await this.ignore(tenantId, event, link, decision.reason);
      }
    } catch (error) {
      return { kind: "failed", error: error instanceof Error ? error.message : "Unexpected monitoring-ingest failure." };
    }
  }

  /** The condition a ticket came from, so a reader can see what the check was. */
  async linkFor(tenantId: string, ticketId: string): Promise<RmmLinkRecord | null> {
    return this.store.findLinkByTicket(tenantId, ticketId);
  }

  /** Every condition this desk has worked, newest first. The connector's own view. */
  async links(tenantId: string): Promise<RmmLinkRecord[]> {
    const links = await this.store.listLinks(tenantId);
    return links.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  /* -------------------------------------------------------------- outcomes */

  private async open(tenantId: string, event: RmmAlertEvent, actor: Actor): Promise<RmmIntakeOutcome> {
    const requesterId = await this.deps.requesterFor(tenantId);
    if (!requesterId) {
      return { kind: "disabled", reason: "This desk has no user a monitoring ticket could be raised for." };
    }

    const draft = rmmTicketDraft(event);
    const created = await this.deps.tickets.createTicket(actor, {
      subject: draft.subject,
      description: draft.description,
      type: draft.type,
      priority: draft.priority,
      requesterId,
    });
    if (!created.ok) return { kind: "failed", error: created.error };

    const link: RmmLinkRecord = {
      id: this.ids.id(),
      tenantId,
      dedupeKey: event.dedupeKey,
      source: event.source,
      host: event.host,
      check: event.check,
      state: "OPEN",
      severity: event.severity,
      externalId: event.externalId,
      ticketId: created.value.id,
      ticketRef: created.value.ref,
      lastSummary: event.summary,
      openedAt: event.occurredAt,
      lastSeenAt: event.occurredAt,
      resolvedAt: null,
      occurrences: 1,
      reopenCount: 0,
    };
    await this.store.insertLink(link);
    await this.append(tenantId, "rmm.alert.open", link, { action: "OPEN" });
    return { kind: "opened", link, ticketId: created.value.id };
  }

  /**
   * The condition failed again after it had cleared.
   *
   * A new ticket, not a reopened one: the last outage is over and its ticket is
   * closed, so this is a second incident with its own response clock and its own
   * record. `reopenCount` is what makes the recurrence visible on the condition.
   */
  private async reopen(
    tenantId: string,
    event: RmmAlertEvent,
    previous: RmmLinkRecord,
    actor: Actor,
    reason: string,
  ): Promise<RmmIntakeOutcome> {
    const requesterId = await this.deps.requesterFor(tenantId);
    if (!requesterId) {
      return { kind: "disabled", reason: "This desk has no user a monitoring ticket could be raised for." };
    }

    const draft = rmmTicketDraft(event);
    const created = await this.deps.tickets.createTicket(actor, {
      subject: draft.subject,
      description: draft.description,
      type: draft.type,
      priority: draft.priority,
      requesterId,
    });
    if (!created.ok) return { kind: "failed", error: created.error };

    const link: RmmLinkRecord = {
      ...previous,
      state: "OPEN",
      severity: event.severity,
      externalId: event.externalId,
      ticketId: created.value.id,
      ticketRef: created.value.ref,
      lastSummary: event.summary,
      openedAt: event.occurredAt,
      lastSeenAt: event.occurredAt,
      resolvedAt: null,
      occurrences: 1,
      reopenCount: previous.reopenCount + 1,
    };
    await this.store.updateLink(link);
    await this.append(tenantId, "rmm.alert.reopen", link, { action: "REOPEN", reason });
    return { kind: "reopened", link, ticketId: created.value.id };
  }

  /**
   * The condition is still failing and we are already working it.
   *
   * The occurrence count and the worst severity move; no second ticket is opened.
   * An internal note carries the vendor's latest words onto the thread, because the
   * message text is often the only place the "why" lives.
   */
  private async repeat(
    tenantId: string,
    event: RmmAlertEvent,
    link: RmmLinkRecord,
    actor: Actor,
  ): Promise<RmmIntakeOutcome> {
    const next: RmmLinkRecord = {
      ...link,
      severity: worstSeverity(link.severity, event.severity),
      lastSummary: event.summary,
      lastSeenAt: event.occurredAt > link.lastSeenAt ? event.occurredAt : link.lastSeenAt,
      externalId: event.externalId,
      occurrences: link.occurrences + 1,
    };
    await this.store.updateLink(next);

    const noted = await this.deps.tickets.reply(actor, link.ticketId, repeatNote(event, link), "INTERNAL_NOTE");
    await this.append(tenantId, "rmm.alert.repeat", next, {
      action: "REPEAT",
      noted: noted.ok,
    });
    return { kind: "repeat", link: next, occurrences: next.occurrences };
  }

  /**
   * The check recovered.
   *
   * The note goes on first, while the ticket is still open, and then the ticket
   * walks its own lifecycle to `CLOSED`. A ticket a person has already closed is
   * left exactly as it is — the clear is still recorded on the link, because when
   * the check came back is a different question from when the desk finished.
   */
  private async resolve(
    tenantId: string,
    event: RmmAlertEvent,
    link: RmmLinkRecord,
    actor: Actor,
    reason: string,
  ): Promise<RmmIntakeOutcome> {
    const ticket = await this.deps.tickets.findTicket(tenantId, link.ticketId);
    if (!ticket) {
      // The ticket is gone (deleted, or a link from a database somebody edited).
      // Recording the clear is still right, and the link says so honestly rather
      // than pointing at a ticket that is not there.
      const orphaned: RmmLinkRecord = {
        ...link,
        state: "RESOLVED",
        resolvedAt: event.occurredAt,
        lastSeenAt: event.occurredAt,
        lastSummary: event.summary,
        externalId: event.externalId,
      };
      await this.store.updateLink(orphaned);
      await this.append(tenantId, "rmm.alert.resolve", orphaned, { action: "RESOLVE", closed: false, reason });
      return { kind: "resolved", link: orphaned, ticketId: link.ticketId };
    }

    await this.deps.tickets.reply(actor, link.ticketId, resolutionNote(event, link), "INTERNAL_NOTE");

    let closed = ticket.status === "CLOSED";
    if (needsClosing(ticket)) {
      closed = true;
      for (const to of closePath(ticket.status)) {
        const moved = await this.deps.tickets.setStatus(actor, link.ticketId, to);
        // A legal edge that was refused means somebody changed the ticket between
        // the read and the write; the link still records the clear, and the event
        // below says the ticket was not walked to the end.
        if (!moved.ok) {
          closed = false;
          break;
        }
      }
    }

    const resolved: RmmLinkRecord = {
      ...link,
      state: "RESOLVED",
      resolvedAt: event.occurredAt,
      lastSeenAt: event.occurredAt,
      lastSummary: event.summary,
      externalId: event.externalId,
    };
    await this.store.updateLink(resolved);
    await this.append(tenantId, "rmm.alert.resolve", resolved, { action: "RESOLVE", closed, reason });
    return { kind: "resolved", link: resolved, ticketId: link.ticketId };
  }

  /**
   * Nothing to do — and, when this desk knew the condition, worth recording.
   *
   * A second recovery for a condition we already closed is recorded, because that
   * means a vendor is reporting twice for one event. A recovery for a condition we
   * have never opened is *not*: the desk has no relationship with that check, and a
   * monitoring system that reports every check's state on every restart would
   * otherwise grow the tenant's evidence chain without saying anything.
   */
  private async ignore(
    tenantId: string,
    event: RmmAlertEvent,
    link: RmmLinkRecord | null,
    reason: string,
  ): Promise<RmmIntakeOutcome> {
    if (link) {
      await this.append(tenantId, "rmm.alert.ignored", link, {
        action: "IGNORE",
        reason,
        state: event.state,
        externalId: event.externalId,
      });
    }
    return { kind: "ignored", reason };
  }

  /* ------------------------------------------------------------- internals */

  private async append(
    tenantId: string,
    action: string,
    link: RmmLinkRecord,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return;
    const event: AuditEventInput = {
      id: this.ids.id(),
      tenantId,
      at: this.ids.now(),
      actor: SYSTEM_RMM_ACTOR,
      action,
      targetType: "rmm-condition",
      // The condition is the durable object here, not the ticket: one condition can
      // become several tickets over its life, and the chain should be readable by
      // condition as well as by ticket.
      targetId: link.dedupeKey,
      detail: {
        dedupeKey: link.dedupeKey,
        source: link.source,
        host: link.host,
        check: link.check,
        state: link.state,
        severity: link.severity,
        externalId: link.externalId,
        ticketId: link.ticketId,
        ticketRef: link.ticketRef,
        occurrences: link.occurrences,
        reopenCount: link.reopenCount,
        ...detail,
      },
    };
    await this.audit.append(event);
  }
}

/* -------------------------------------------------------------------------- */
/*  An in-memory store, used by tests and local development                   */
/* -------------------------------------------------------------------------- */

export class MemoryRmmStore implements RmmStore {
  private readonly links = new Map<string, RmmLinkRecord>();

  async findLink(tenantId: string, dedupeKey: string): Promise<RmmLinkRecord | null> {
    for (const link of this.links.values()) {
      if (link.tenantId === tenantId && link.dedupeKey === dedupeKey) return structuredClone(link);
    }
    return null;
  }

  async findLinkByTicket(tenantId: string, ticketId: string): Promise<RmmLinkRecord | null> {
    for (const link of this.links.values()) {
      if (link.tenantId === tenantId && link.ticketId === ticketId) return structuredClone(link);
    }
    return null;
  }

  async listLinks(tenantId: string): Promise<RmmLinkRecord[]> {
    return [...this.links.values()]
      .filter((link) => link.tenantId === tenantId)
      .map((link) => structuredClone(link));
  }

  async insertLink(record: RmmLinkRecord): Promise<void> {
    this.links.set(record.id, structuredClone(record));
  }

  async updateLink(record: RmmLinkRecord): Promise<void> {
    this.links.set(record.id, structuredClone(record));
  }
}
