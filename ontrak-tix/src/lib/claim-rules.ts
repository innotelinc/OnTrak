/**
 * Claim-on-view rules: whoever opens a piece of work owns it.
 *
 * A queue where everything is "unassigned" is a queue where everybody assumes somebody
 * else has it, and the ticket that nobody owns is the one that breaches. So the desk takes
 * the work the moment a person opens it: the ticket becomes theirs and moves into
 * `PENDING`, which is the status that means "this is in someone's hands" rather than
 * "nobody has looked".
 *
 * Three refusals, each of which is a real desk's failure mode:
 *
 *  - **Never take work off somebody else.** A claim only ever fills an empty hand or
 *    advances the claimer's own ticket. A ticket assigned to a colleague stays with them
 *    however many times you open it; taking it is a deliberate act with its own control.
 *  - **Never claim history.** A resolved or closed ticket is a record, not a queue.
 *    Reopening it is a decision, and a claim-on-view must not be able to make it by
 *    accident.
 *  - **A requester never claims.** Viewing your own request is not taking work — it needs
 *    `ticket:update`, the permission to work the desk at all, so a requester's own portal
 *    is untouched by this.
 *
 * `ticket:update` rather than `ticket:assign` is deliberate: an AGENT cannot hand work to
 * anybody (only a dispatcher or an administrator can), but pulling the ticket in front of
 * you is not handing it to somebody — it is picking it up.
 */

import { actorHasPermission, isSameTenant, type Actor, type TicketScope } from "./access-rules";
import { canTransition, type TicketStatus } from "./ticket-rules";

/**
 * The status a claimed ticket lands in.
 *
 * `NEW` means nobody has touched it and `OPEN` means it is being worked without a stated
 * hand-off; `PENDING` is the one that says the work is with a named person. Since the
 * claim is exactly that statement, it is the status that follows from it.
 */
export const CLAIM_STATUS: TicketStatus = "PENDING";

/** What a claim decision needs to know about a ticket. */
export interface ClaimableTicket extends TicketScope {
  id: string;
  status: TicketStatus;
}

export interface ClaimDecision {
  /** True when opening this ticket should take it. */
  claim: boolean;
  /** The assignee the claim would set — the claimer. */
  assigneeId: string;
  /** True when the status moves to `PENDING` as part of the claim. */
  move: boolean;
  /** Why, in a sentence, whether it happened or not. */
  reason: string;
}

/**
 * Decide whether opening a ticket claims it.
 *
 * Pure, so the two views that can claim — the ticket page and the inbox's selection panel —
 * ask the same question of the same function, and a test can assert the refusals without a
 * database or a session.
 */
export function claimOnView(actor: Actor, ticket: ClaimableTicket): ClaimDecision {
  const mine = ticket.assigneeId === actor.id;
  const decided = {
    claim: false as const,
    assigneeId: actor.id,
    move: false,
    reason: "",
  };

  if (!isSameTenant(actor, ticket.tenantId)) {
    return { ...decided, reason: "That ticket belongs to another desk." };
  }
  if (!actorHasPermission(actor, "ticket:update")) {
    return { ...decided, reason: "You do not work the desk's queue." };
  }
  if (ticket.status === "RESOLVED" || ticket.status === "CLOSED") {
    return { ...decided, reason: "That work is finished; reopen it deliberately if it is back." };
  }
  if (ticket.assigneeId && !mine) {
    return { ...decided, reason: "Somebody else has that ticket." };
  }

  const move = canTransition(ticket.status, CLAIM_STATUS);
  if (mine && !move) {
    return { ...decided, reason: "Already yours, and already in hand." };
  }

  return {
    claim: true,
    assigneeId: actor.id,
    move,
    reason: mine
      ? "Yours already — moved into pending."
      : move
        ? "Taken and moved into pending."
        : "Taken.",
  };
}
