/**
 * Ticket link rules (M1): relating two tickets, and merging a duplicate into a
 * survivor.
 *
 * Links are stored one row per direction so a ticket's "related" list is a
 * single query rather than a union. `PARENT`/`CHILD` are reciprocal views of the
 * same relationship; `DUPLICATE` is what a merge writes.
 *
 * A merge is deliberately *not* run through the status machine: folding a brand
 * new duplicate into a live ticket is a normal desk action, and the lifecycle
 * forbids `NEW → CLOSED` on purpose (a person must work a ticket). Merge is a
 * privileged, audited override, so it takes the shortest path and records why.
 */

import type { Actor } from "./access-rules";
import { actorHasPermission } from "./access-rules";
import { highestPriority } from "./ticket-rules";
import { applyPauseForStatus, type TicketMessage, type TicketRecord } from "./ticket-service";

export const LINK_KINDS = ["RELATED", "DUPLICATE", "PARENT", "CHILD"] as const;
export type TicketLinkKind = (typeof LINK_KINDS)[number];

export interface TicketLink {
  id: string;
  tenantId: string;
  fromTicketId: string;
  toTicketId: string;
  kind: TicketLinkKind;
  createdBy: string | null;
  createdAt: string;
}

export function isLinkKind(value: unknown): value is TicketLinkKind {
  return typeof value === "string" && (LINK_KINDS as readonly string[]).includes(value);
}

/** The kind written on the other ticket so both ends agree. */
export function reciprocalKind(kind: TicketLinkKind): TicketLinkKind {
  switch (kind) {
    case "PARENT":
      return "CHILD";
    case "CHILD":
      return "PARENT";
    default:
      return kind;
  }
}

export interface LinkIssue {
  field: string;
  message: string;
}

/** Whether a link may be created. Self-links and exact duplicates are refused. */
export function validateLink(
  fromTicketId: string,
  toTicketId: string,
  existing: readonly Pick<TicketLink, "fromTicketId" | "toTicketId">[] = [],
): LinkIssue[] {
  const issues: LinkIssue[] = [];
  if (!fromTicketId || !toTicketId) {
    issues.push({ field: "toTicketId", message: "Choose a ticket to link." });
    return issues;
  }
  if (fromTicketId === toTicketId) {
    issues.push({ field: "toTicketId", message: "A ticket cannot be linked to itself." });
  }
  if (existing.some((link) => link.fromTicketId === fromTicketId && link.toTicketId === toTicketId)) {
    issues.push({ field: "toTicketId", message: "These tickets are already linked." });
  }
  return issues;
}

/** The minimum a ticket must expose to appear in a link list. */
export interface LinkTarget {
  id: string;
  ref: string;
  subject: string;
}

/** One related ticket, from `ticketId`'s point of view. */
export interface LinkedTicketView {
  linkId: string;
  ticketId: string;
  ref: string;
  subject: string;
  kind: TicketLinkKind;
  direction: "outgoing" | "incoming";
}

/**
 * Project a ticket's link rows into the view its detail screen shows: the other
 * end of each link, with the direction it was recorded. Targets missing from the
 * map (a deleted ticket) are skipped rather than rendered blank.
 */
export function linkViews(
  links: readonly TicketLink[],
  ticketId: string,
  targets: ReadonlyMap<string, LinkTarget>,
): LinkedTicketView[] {
  const views: LinkedTicketView[] = [];
  for (const link of links) {
    const outgoing = link.fromTicketId === ticketId;
    const otherId = outgoing ? link.toTicketId : link.fromTicketId;
    const other = targets.get(otherId);
    if (!other) continue;
    views.push({
      linkId: link.id,
      ticketId: other.id,
      ref: other.ref,
      subject: other.subject,
      // A link stores one kind; the other end sees its reciprocal, so a CHILD
      // does not read as a PARENT depending on which page you opened.
      kind: outgoing ? link.kind : reciprocalKind(link.kind),
      direction: outgoing ? "outgoing" : "incoming",
    });
  }
  return views.sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Only staff who may update tickets may relate or merge them. */
export function canLinkTickets(actor: Actor): boolean {
  return actorHasPermission(actor, "ticket:update");
}

export interface MergePlan {
  survivor: TicketRecord;
  duplicate: TicketRecord;
  link: Omit<TicketLink, "id" | "createdAt">;
  audit: { action: string; targetId: string; detail: Record<string, unknown> }[];
}

/**
 * Fold `duplicate` into `survivor`.
 *
 *  - The duplicate's messages are copied onto the survivor, ahead of a `SYSTEM`
 *    message recording the merge, so the survivor's thread is the full story. A
 *    `messageId`-based source id is carried across so a later email reply still
 *    threads.
 *  - The duplicate is closed and left in place; nothing is deleted, and the
 *    `DUPLICATE` link is the pointer forward.
 *  - The survivor's priority is raised to the higher of the two, because a
 *    duplicate is often the more urgent report.
 */
export function planMerge(
  actor: Actor,
  survivor: TicketRecord,
  duplicate: TicketRecord,
  makeId: () => string,
  now: string,
): MergePlan {
  const carried: TicketMessage[] = duplicate.messages.map((message) => ({
    ...message,
    id: makeId(),
    kind: message.kind === "SYSTEM" ? "INTERNAL_NOTE" : message.kind,
  }));

  const note: TicketMessage = {
    id: makeId(),
    kind: "SYSTEM",
    body: `${duplicate.ref} (“${duplicate.subject}”) was merged into this ticket by ${actor.id}.`,
    authorId: null,
    createdAt: now,
  };

  const winner = highestPriority(survivor.priority, duplicate.priority);

  return {
    survivor: {
      ...survivor,
      priority: winner,
      updatedAt: now,
      messages: [...survivor.messages, ...carried, note],
    },
    duplicate: {
      ...duplicate,
      status: "CLOSED",
      updatedAt: now,
      closedAt: now,
      // Closing a waiting ticket ends its pause, so the record is not left with
      // an open-ended window that would freeze the clock forever.
      pauses: applyPauseForStatus(duplicate.pauses, duplicate.status, "CLOSED", now),
    },
    link: {
      tenantId: survivor.tenantId,
      fromTicketId: duplicate.id,
      toTicketId: survivor.id,
      kind: "DUPLICATE",
      createdBy: actor.id,
    },
    audit: [
      {
        action: "ticket.merge",
        targetId: survivor.id,
        detail: { survivor: survivor.ref, duplicate: duplicate.ref, duplicateId: duplicate.id },
      },
    ],
  };
}
