/**
 * Containment requests (S4/S5): prevention asked for by *another product*.
 *
 * Sentinel's console can propose an action, and so can a person. This module is the third
 * door, and the one the family needed: **the desk asks.** An analyst triaging an alert in
 * OnTrak Tix is looking at the ticket, the client, the SLA and the asset record, and is
 * exactly the person in a position to say "block that address" — but the place enforcement
 * is decided, approved and undone is here, because the safe-list, the blast-radius cap, the
 * hourly limit and the second-approver rail all live on this side of the boundary.
 *
 * So a containment request is a **proposal, not an order**, and three decisions say so:
 *
 *  - **The desk's role is mapped, never assumed.** Tix's vocabulary (`ADMIN`, `DISPATCHER`,
 *    `AGENT`, `REQUESTER`) and Sentinel's (`ADMIN`, `AGENT`, `SERVICE`, `AUDITOR`) are
 *    different sets on purpose, and the mapping here is explicit. A role this build does not
 *    recognise is **refused by name** rather than defaulted to something powerful — silently
 *    treating an unknown role as an agent is how an integration becomes a privilege
 *    escalation.
 *  - **The rails decide, not the caller.** A desk request goes through `decideEnforcement`
 *    exactly as a console proposal does: protected targets are refused even for an
 *    administrator, a blast radius over the cap is refused rather than truncated, and the
 *    default policy's second-approver rule means a desk request lands `PENDING` for a
 *    Sentinel administrator to approve. `requesterIsApprover` is false for a mapped `AGENT`,
 *    so an agent's request can never self-approve.
 *  - **The requester is namespaced.** The identity is `tix:<id>`, which cannot collide with a
 *    Sentinel identity — so the second-approver rail ("a *different* administrator") works
 *    without anybody mapping account ids across two products, and the audit row reads as what
 *    it is: the desk asked.
 *
 * The parsing is total and refuses with sentences, like every other request reader here. It
 * never builds a proposal the rails would have to refuse for a reason the desk could have
 * been told up front.
 */

import {
  ENFORCEMENT_ACTION_KINDS,
  ENFORCEMENT_TARGET_KINDS,
  type EnforcementActionKind,
  type EnforcementTarget,
  type EnforcementTargetKind,
} from "./enforcement-rules";
import type { IdentityRole } from "./identity-rules";

/* -------------------------------------------------------------------------- */
/*  Roles                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The desk's role, as Sentinel's.
 *
 * Written out rather than derived: the two vocabularies are different languages for
 * different jobs, and a mapping table is the only honest way to translate between them.
 * `null` means "this build does not know that role", which the caller refuses.
 *
 * `DISPATCHER` maps to `AGENT` rather than to `ADMIN`: a dispatcher owns the queue and not
 * the network, and the family's own `SYSADMIN`/`ANALYST` names are accepted too so a
 * deployment using the canonical family vocabulary is not refused for using it.
 */
const DESK_ROLE_MAP: Record<string, IdentityRole> = {
  ADMIN: "ADMIN",
  SYSADMIN: "ADMIN",
  DISPATCHER: "AGENT",
  AGENT: "AGENT",
  ANALYST: "AGENT",
  TECHNICIAN: "AGENT",
  SERVICE: "SERVICE",
  AUDITOR: "AUDITOR",
};

export function mapDeskRole(role: string): IdentityRole | null {
  return DESK_ROLE_MAP[role.trim().toUpperCase()] ?? null;
}

/* -------------------------------------------------------------------------- */
/*  The request                                                               */
/* -------------------------------------------------------------------------- */

export interface ContainmentRequest {
  /** The detection this answers. The desk's own alert id — the rails require a detection. */
  alertId: string;
  action: EnforcementActionKind;
  targets: EnforcementTarget[];
  reason: string;
  /** The person who asked, in the desk's terms. */
  requestedBy: { id: string; label: string; role: string };
  /** When the detection was first seen, for the measured time-to-prevent. */
  detectedAt: string | null;
}

export type ReadContainment =
  | { ok: true; value: ContainmentRequest }
  | { ok: false; error: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function readTargets(value: unknown): { targets: EnforcementTarget[]; error: string | null } {
  if (!Array.isArray(value) || value.length === 0) {
    return { targets: [], error: "A containment request needs at least one target." };
  }

  const targets: EnforcementTarget[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      return { targets: [], error: "Every target has to be an object with a kind and a value." };
    }
    const record = entry as Record<string, unknown>;
    const kind = text(record.kind).toUpperCase() as EnforcementTargetKind;
    const target = text(record.value);
    if (!(ENFORCEMENT_TARGET_KINDS as readonly string[]).includes(kind)) {
      return {
        targets: [],
        error: `“${text(record.kind)}” is not a target kind this build knows (${ENFORCEMENT_TARGET_KINDS.join(", ")}).`,
      };
    }
    if (target === "") return { targets: [], error: `A ${kind} target needs a value.` };
    const label = text(record.label);
    targets.push(label === "" ? { kind, value: target } : { kind, value: target, label });
  }

  return { targets, error: null };
}

/**
 * Read a containment request body.
 *
 * Every refusal is a sentence naming what was missing, because the caller is a *product*
 * whose operator is looking at a screen — "400" alone leaves somebody guessing at a payload
 * they did not hand-write.
 */
export function readContainmentRequest(body: unknown): ReadContainment {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "A containment request has to be a JSON object." };
  }
  const raw = body as Record<string, unknown>;

  const alertId = text(raw.alertId) || text(raw.detectionId);
  if (alertId === "") {
    return { ok: false, error: "A containment request has to name the detection it answers (alertId)." };
  }

  const action = text(raw.action).toUpperCase() as EnforcementActionKind;
  if (!(ENFORCEMENT_ACTION_KINDS as readonly string[]).includes(action)) {
    return {
      ok: false,
      error: `“${text(raw.action)}” is not an action this build knows (${ENFORCEMENT_ACTION_KINDS.join(", ")}).`,
    };
  }

  const { targets, error } = readTargets(raw.targets);
  if (error) return { ok: false, error };

  const reason = text(raw.reason);
  if (reason === "") {
    // Required by the rails too, and refused here with a sentence rather than there with a
    // code: a block with no note is unauditable, and the caller can still fix it.
    return { ok: false, error: "A containment request needs a reason; the audit row is what somebody reads later." };
  }

  const requested = (typeof raw.requestedBy === "object" && raw.requestedBy !== null
    ? raw.requestedBy
    : {}) as Record<string, unknown>;
  const label = text(requested.label) || text(requested.id);
  const role = text(requested.role);
  if (label === "") {
    return { ok: false, error: "A containment request has to name who asked for it." };
  }
  if (mapDeskRole(role) === null) {
    return {
      ok: false,
      error:
        `“${role}” is not a desk role this deployment can map to one of Sentinel's. ` +
        `Prevention is an administrator's action; send the role the person actually holds.`,
    };
  }

  const detectedAt = text(raw.detectedAt);

  return {
    ok: true,
    value: {
      alertId,
      action,
      targets,
      reason,
      requestedBy: { id: text(requested.id) || label, label, role },
      detectedAt: detectedAt === "" ? null : detectedAt,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  What the desk is told                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of a containment request, as the desk records it.
 *
 * Three states rather than a boolean, because "the block is in force", "the block is waiting
 * for an approver here" and "a rail refused it" are three different things for the desk to
 * show — and collapsing the last two into a failure would hide the fact that somebody in
 * Sentinel has something to approve.
 */
export type ContainmentOutcome = "APPLIED" | "PENDING" | "REFUSED";

export interface ContainmentReply {
  outcome: ContainmentOutcome;
  /** Sentinel's own action id, so the desk can point at the action it asked for. */
  actionId: string | null;
  /** The action as Sentinel stored it: `ACTIVE`, `PENDING` or `REFUSED`. */
  state: string | null;
  /** Why it was refused, or `null`. */
  reason: string | null;
}

export function containmentReply(input: {
  gate: "IMMEDIATE" | "APPROVAL_REQUIRED";
  actionId: string;
  state: string;
}): ContainmentReply {
  return {
    outcome: input.gate === "IMMEDIATE" ? "APPLIED" : "PENDING",
    actionId: input.actionId,
    state: input.state,
    reason: null,
  };
}

export function containmentRefusal(reason: string): ContainmentReply {
  return { outcome: "REFUSED", actionId: null, state: null, reason };
}

/**
 * A sentence for the desk's own record, in its own voice.
 *
 * Kept here rather than in the desk so the two products cannot disagree about what an
 * outcome means: the sentence a Tix operator reads is derived from the same reply the
 * integration recorded.
 */
export function describeContainment(reply: ContainmentReply): string {
  switch (reply.outcome) {
    case "APPLIED":
      return "Sentinel applied the containment action; it lifts on its own time limit or when an administrator lifts it.";
    case "PENDING":
      return "Sentinel recorded the proposal and it is waiting for a Sentinel administrator to approve it. Nothing is blocked yet.";
    case "REFUSED":
      return `Sentinel refused the containment action: ${reply.reason ?? "a rail refused it."}`;
  }
}

/* -------------------------------------------------------------------------- */
/*  The HTTP contract                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Status codes for a containment request.
 *
 * `202` for both applied and pending, because both mean *taken*: the difference is in the
 * body, and a desk that treated "pending" as an error would retry a request that is working
 * exactly as designed. `409` for a refusal, because the request was understood and the
 * answer is no — a retry cannot change it.
 */
export function containmentStatus(reply: ContainmentReply): number {
  return reply.outcome === "REFUSED" ? 409 : 202;
}
