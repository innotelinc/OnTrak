/**
 * Ticket link & merge service (M1).
 *
 * Writes links in both directions (so either ticket lists the other) and owns
 * the merge: it loads both tickets, plans the fold with `planMerge`, persists
 * the survivor, the closed duplicate and the `DUPLICATE` link, and emits the
 * audit events.
 *
 * The merge deliberately bypasses the status machine — see `link-rules.ts` —
 * and is gated on `ticket:update`, so only staff can do it.
 */

import { randomUUID } from "node:crypto";

import type { Actor } from "./access-rules";
import { canUpdateTicket } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  canLinkTickets,
  linkViews,
  planMerge,
  validateLink,
  type LinkedTicketView,
  type LinkTarget,
  type TicketLink,
  type TicketLinkKind,
} from "./link-rules";
import type { TicketStore } from "./ticket-service";

export interface LinkStore {
  listForTenant(tenantId: string): Promise<TicketLink[]>;
  insert(link: TicketLink): Promise<void>;
}

export type LinkResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface LinkIds {
  linkId(): string;
  messageId(): string;
  now(): string;
}

export function systemLinkIds(): LinkIds {
  return { linkId: () => randomUUID(), messageId: () => randomUUID(), now: () => new Date().toISOString() };
}

export class TicketLinkService {
  constructor(
    private readonly links: LinkStore,
    private readonly tickets: TicketStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: LinkIds = systemLinkIds(),
  ) {}

  /** Links pointing at or from a ticket, newest first. */
  async linksFor(tenantId: string, ticketId: string): Promise<TicketLink[]> {
    const all = await this.links.listForTenant(tenantId);
    return all
      .filter((link) => link.fromTicketId === ticketId || link.toTicketId === ticketId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** The related tickets a detail screen shows, resolved to refs and subjects. */
  async linkedTickets(tenantId: string, ticketId: string): Promise<LinkedTicketView[]> {
    const [links, tickets] = await Promise.all([this.linksFor(tenantId, ticketId), this.tickets.listTickets(tenantId)]);
    const targets = new Map<string, LinkTarget>(
      tickets.map((ticket) => [ticket.id, { id: ticket.id, ref: ticket.ref, subject: ticket.subject }]),
    );
    return linkViews(links, ticketId, targets);
  }

  /** Relate two tickets. Writes both directions so each ticket shows the other. */
  async link(
    actor: Actor,
    fromTicketId: string,
    toTicketId: string,
    kind: TicketLinkKind = "RELATED",
  ): Promise<LinkResult<TicketLink>> {
    if (!canLinkTickets(actor)) return { ok: false, error: "You cannot link tickets." };

    const from = await this.tickets.findTicket(actor.tenantId, fromTicketId);
    const to = await this.tickets.findTicket(actor.tenantId, toTicketId);
    if (!from || !to) return { ok: false, error: "Ticket not found." };

    const existing = await this.links.listForTenant(actor.tenantId);
    const issues = validateLink(from.id, to.id, existing);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const at = this.ids.now();
    // One row per relation: both ends are already covered by reading
    // `from OR to`, and `linkViews` reciprocates the kind for the far end.
    const link: TicketLink = {
      id: this.ids.linkId(),
      tenantId: actor.tenantId,
      fromTicketId: from.id,
      toTicketId: to.id,
      kind,
      createdBy: actor.id,
      createdAt: at,
    };
    await this.links.insert(link);
    await this.emit(actor, "ticket.link", from.id, { from: from.ref, to: to.ref, kind });
    return { ok: true, value: link };
  }

  /**
   * Merge `duplicateId` into `survivorId`. The survivor's thread absorbs the
   * duplicate's messages, the duplicate is closed, and a `DUPLICATE` link points
   * forward. Nothing is deleted.
   */
  async merge(actor: Actor, survivorId: string, duplicateId: string): Promise<LinkResult<{ survivorId: string; duplicateId: string }>> {
    const survivor = await this.tickets.findTicket(actor.tenantId, survivorId);
    const duplicate = await this.tickets.findTicket(actor.tenantId, duplicateId);
    if (!survivor || !duplicate) return { ok: false, error: "Ticket not found." };
    if (!canUpdateTicket(actor, survivor) || !canUpdateTicket(actor, duplicate)) {
      return { ok: false, error: "You cannot merge these tickets." };
    }
    if (survivor.id === duplicate.id) return { ok: false, error: "A ticket cannot be merged into itself." };

    const at = this.ids.now();
    const plan = planMerge(actor, survivor, duplicate, () => this.ids.messageId(), at);

    await this.tickets.updateTicket(plan.survivor);
    await this.tickets.updateTicket(plan.duplicate);

    const existing = await this.links.listForTenant(actor.tenantId);
    if (!existing.some((link) => link.fromTicketId === duplicate.id && link.toTicketId === survivor.id)) {
      await this.links.insert({ id: this.ids.linkId(), createdAt: at, ...plan.link });
    }

    for (const event of plan.audit) {
      await this.emit(actor, event.action, event.targetId, event.detail);
    }
    return { ok: true, value: { survivorId: survivor.id, duplicateId: duplicate.id } };
  }

  private async emit(actor: Actor, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    if (!this.audit) return;
    const event: AuditEventInput = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      at: this.ids.now(),
      actor: actor.id,
      action,
      targetType: "ticket",
      targetId,
      detail,
    };
    await this.audit.append(event);
  }
}

/** An in-memory link store for tests and local development. */
export class MemoryLinkStore implements LinkStore {
  private readonly links = new Map<string, TicketLink>();

  async listForTenant(tenantId: string): Promise<TicketLink[]> {
    return [...this.links.values()]
      .filter((link) => link.tenantId === tenantId)
      .map((link) => structuredClone(link));
  }

  async insert(link: TicketLink): Promise<void> {
    this.links.set(link.id, structuredClone(link));
  }
}
