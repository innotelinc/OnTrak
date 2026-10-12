/**
 * Containment from the desk (M2/S5): the other half of the Sentinel integration.
 *
 * Sentinel pushes its detections in (`sentinel-ingest.ts`, `security-alert-connector.ts`).
 * This is the direction that makes the pair worth wiring: an analyst looking at a ticket —
 * with the client, the SLA, the asset record and the change calendar in front of them — is
 * the person best placed to say "block that address", and until now the only way to act on
 * that was to open a second console.
 *
 * What this module deliberately is **not** is an enforcement path. It asks.
 *
 *  - **The rails are Sentinel's.** Sentinel's safe-list, blast-radius cap, hourly limit and
 *    second-approver rule all still run, and they run there rather than here. A desk request
 *    is a *proposal*; a refusal comes back as a recorded outcome the desk shows, not as an
 *    error to retry.
 *  - **It will usually come back `PENDING`, and that is the design.** The requester is
 *    namespaced `tix:<id>`, so a desk administrator can never be the Sentinel administrator
 *    who approves it — a block asked for by the desk always needs a second pair of eyes on the
 *    side that owns the firewall.
 *  - **Every outcome lands on the desk's own hash chain.** Applied, pending and refused alike
 *    (`security.containment.applied` / `.pending` / `.refused` / `.failed`), so "we asked for
 *    that host to be isolated" is answerable from the record rather than from somebody's
 *    memory of a console they had open at the time.
 *
 * The target is derived from the alert rather than chosen by a form: the desk is asking about
 * the thing that was detected, and a free-text target box on a security console is a box
 * somebody fills in wrong once.
 */

import type { AuditSink } from "./audit-chain";
import { containmentAudit, type SecurityAlertRecord, type SecurityAlertService, type ContainmentState } from "./security-alert-service";

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

/** The environment keys a Sentinel target is read from. */
export const SENTINEL_TARGET_ENV = {
  /** Sentinel's origin, e.g. `https://sentinel.example.test`. */
  baseUrl: "ONTRAK_TIX_SENTINEL_BASE_URL",
  /** The containment token minted in Sentinel (`SENTINEL_CONTAINMENT_TOKEN`). */
  token: "ONTRAK_TIX_SENTINEL_TOKEN",
  /** Which Sentinel organization this desk's alerts belong to. */
  organization: "ONTRAK_TIX_SENTINEL_ORGANIZATION",
} as const;

/** The containment path on Sentinel's guard surface. */
export const SENTINEL_CONTAINMENT_PATH = "/guard/v1/containment";

export interface SentinelTarget {
  baseUrl: string;
  token: string;
  organization: string;
}

/**
 * The Sentinel this deployment acts on, or `null` when none is configured.
 *
 * All three values are required, and a half-configured block is reported as *not configured*
 * rather than half-used — an action that reached the wrong origin, or the right origin with no
 * organization, would be worse than one that refused to leave.
 */
export function sentinelTargetFromEnv(
  env: Record<string, string | undefined> = process.env,
): SentinelTarget | null {
  const baseUrl = (env[SENTINEL_TARGET_ENV.baseUrl] ?? "").trim().replace(/\/+$/, "");
  const token = (env[SENTINEL_TARGET_ENV.token] ?? "").trim();
  const organization = (env[SENTINEL_TARGET_ENV.organization] ?? "").trim();
  if (baseUrl === "" || token === "" || organization === "") return null;
  return { baseUrl, token, organization };
}

/** The variables a deployment is missing, so a refusal can name them. */
export function sentinelTargetGaps(env: Record<string, string | undefined> = process.env): string[] {
  const missing: string[] = [];
  if ((env[SENTINEL_TARGET_ENV.baseUrl] ?? "").trim() === "") missing.push(SENTINEL_TARGET_ENV.baseUrl);
  if ((env[SENTINEL_TARGET_ENV.token] ?? "").trim() === "") missing.push(SENTINEL_TARGET_ENV.token);
  if ((env[SENTINEL_TARGET_ENV.organization] ?? "").trim() === "") missing.push(SENTINEL_TARGET_ENV.organization);
  return missing;
}

/* -------------------------------------------------------------------------- */
/*  What to ask for                                                           */
/* -------------------------------------------------------------------------- */

export type ContainmentProposal =
  | { ok: true; action: "BLOCK" | "QUARANTINE"; targets: { kind: "ADDRESS" | "IDENTITY" | "DEVICE"; value: string; label?: string }[] }
  | { ok: false; error: string };

/**
 * The action an alert warrants, from what the alert actually names.
 *
 * An address is blocked and an identity or a device is quarantined — different verbs because
 * they are different acts: a block drops traffic from an address, a quarantine isolates an
 * account or a machine and is the heavier of the two. Which one applies is decided by what the
 * detection names, in that order, and an alert that names none of them is refused rather than
 * given a target the desk did not mean.
 */
export function containmentProposalFor(alert: Pick<SecurityAlertRecord, "sourceIp" | "identity" | "asset">): ContainmentProposal {
  const address = alert.sourceIp?.trim();
  if (address) {
    return { ok: true, action: "BLOCK", targets: [{ kind: "ADDRESS", value: address, label: "detected source" }] };
  }

  const identity = alert.identity?.trim();
  if (identity) {
    return { ok: true, action: "QUARANTINE", targets: [{ kind: "IDENTITY", value: identity, label: "detected identity" }] };
  }

  const asset = alert.asset?.trim();
  if (asset) {
    return { ok: true, action: "QUARANTINE", targets: [{ kind: "DEVICE", value: asset, label: "detected asset" }] };
  }

  return {
    ok: false,
    error:
      "This alert names no source address, identity or asset, so there is nothing to contain. " +
      "The decision is about the evidence, and the evidence is what it does not have.",
  };
}

/**
 * The body Sentinel's containment door reads. Mirrors `containment-rules.ts` there.
 *
 * A discriminated result rather than a union with an `error` key on both arms: `"error" in body`
 * does not narrow `Record<string, unknown>`, so a caller would be left holding an `unknown` for
 * the very thing it is supposed to show somebody.
 */
export function containmentRequestBody(
  alert: SecurityAlertRecord,
  input: { reason: string; requestedBy: { id: string; label: string; role: string } },
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const proposal = containmentProposalFor(alert);
  if (!proposal.ok) return { ok: false, error: proposal.error };

  return {
    ok: true,
    value: {
      // Sentinel's rails require a detection behind an action, and this is it: the desk's alert
      // id, so the action's audit row points at the same detection the desk is looking at.
      alertId: alert.id,
      action: proposal.action,
      targets: proposal.targets,
      reason: input.reason.trim(),
      requestedBy: input.requestedBy,
      detectedAt: alert.firstSeenAt,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  The client                                                                */
/* -------------------------------------------------------------------------- */

export interface ContainmentAnswer {
  outcome: "APPLIED" | "PENDING" | "REFUSED";
  /** Sentinel's own action id, kept so the two records point at each other. */
  actionId: string | null;
  state: string | null;
  reason: string | null;
}

export type ContainmentCall =
  | { ok: true; value: ContainmentAnswer }
  | { ok: false; error: string };

export interface SentinelContainmentClient {
  request(body: Record<string, unknown>): Promise<ContainmentCall>;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * The HTTP client.
 *
 * A `409` is the interesting one: Sentinel answers it when its *rails* refused, which is a
 * decision rather than a transport problem. It is parsed and returned as `REFUSED` with
 * Sentinel's own sentence, because "the safe-list refused this" is something an operator has
 * to read, and a generic failure would hide the one detail that explains it.
 */
export class HttpSentinelContainment implements SentinelContainmentClient {
  constructor(
    private readonly target: SentinelTarget,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async request(body: Record<string, unknown>): Promise<ContainmentCall> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.target.baseUrl}${SENTINEL_CONTAINMENT_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${this.target.token}`,
          "x-sentinel-organization": this.target.organization,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;

      if (response.status === 202 || response.status === 409) {
        const outcome = record.outcome === "APPLIED" || record.outcome === "PENDING" || record.outcome === "REFUSED"
          ? record.outcome
          : response.status === 409
            ? "REFUSED"
            : "PENDING";
        return {
          ok: true,
          value: {
            outcome,
            actionId: typeof record.actionId === "string" ? record.actionId : null,
            state: typeof record.state === "string" ? record.state : null,
            reason: typeof record.reason === "string" ? record.reason : null,
          },
        };
      }

      const detail = typeof record.error === "string" ? record.error : "";
      return { ok: false, error: `Sentinel answered ${response.status}${detail === "" ? "" : `: ${detail}`}` };
    } catch (error) {
      return { ok: false, error: `Sentinel unreachable: ${error instanceof Error ? error.message : "unknown error"}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

export interface ContainmentOutcomeView {
  state: ContainmentState;
  /** A sentence for the operator, in the desk's own voice. */
  message: string;
}

/**
 * Ask Sentinel to contain what an alert names, and record the answer either way.
 *
 * The write order matters: the alert's state is written *from* the reply, so the queue and the
 * chain cannot disagree about what happened — if the write fails the chain is not appended, and
 * if the chain fails the state is still the truth about the block. Every path is recorded,
 * because an ask that produced nothing is exactly the thing an incident review asks about.
 */
export class SentinelContainmentService {
  constructor(
    private readonly alerts: Pick<SecurityAlertService, "get" | "linkContainment">,
    private readonly client: SentinelContainmentClient,
    private readonly audit: AuditSink | null = null,
  ) {}

  async request(input: {
    tenantId: string;
    alertId: string;
    reason: string;
    requestedBy: { id: string; label: string; role: string };
  }): Promise<{ ok: true; value: ContainmentOutcomeView } | { ok: false; error: string }> {
    if (input.reason.trim() === "") {
      // Sentinel refuses a note-less action too, and refusing here says it before a request
      // crosses a network boundary to be told the same thing less usefully.
      return { ok: false, error: "A containment request needs a reason; it is what the audit row records." };
    }

    const alert = await this.alerts.get(input.tenantId, input.alertId);
    if (!alert) return { ok: false, error: "Alert not found." };

    const body = containmentRequestBody(alert, input);
    if (!body.ok) return { ok: false, error: body.error };

    const call = await this.client.request(body.value);

    if (!call.ok) {
      const recorded = await this.alerts.linkContainment(input.tenantId, alert.id, { state: "FAILED", actionId: null });
      if (recorded) {
        await this.append(recorded, {
          action: String(body.value.action),
          outcome: "FAILED",
          actionId: null,
          reason: call.error,
          by: input.requestedBy.label,
        });
      }
      // Reported as a refusal the desk reads rather than an exception: the alert is untouched,
      // and what the operator needs is Sentinel's own words.
      return {
        ok: true,
        value: {
          state: "FAILED",
          message: `Sentinel could not be asked: ${call.error}. Nothing was blocked, and the refusal is on the alert's record.`,
        },
      };
    }

    const state: ContainmentState =
      call.value.outcome === "APPLIED" ? "APPLIED" : call.value.outcome === "PENDING" ? "PENDING" : "REFUSED";

    const recorded = await this.alerts.linkContainment(input.tenantId, alert.id, {
      state,
      actionId: call.value.actionId,
    });
    if (recorded) {
      await this.append(recorded, {
        action: String(body.value.action),
        outcome: state,
        actionId: call.value.actionId,
        reason: call.value.reason,
        by: input.requestedBy.label,
      });
    }

    return { ok: true, value: { state, message: describeOutcome(state, call.value.reason) } };
  }

  private async append(
    record: SecurityAlertRecord,
    input: { action: string; outcome: string; actionId: string | null; reason: string | null; by: string },
  ): Promise<void> {
    if (!this.audit) return;
    await this.audit.append(containmentAudit(record, input));
  }
}

/**
 * What the operator is told, per state.
 *
 * The `PENDING` sentence is the important one: a desk that read it as "blocked" would stop
 * watching a host that nothing is actually blocking yet.
 */
export function describeOutcome(state: ContainmentState, reason: string | null): string {
  switch (state) {
    case "APPLIED":
      return "Sentinel applied the containment action. It lifts on its own time limit, or when a Sentinel administrator lifts it.";
    case "PENDING":
      return "Sentinel recorded the proposal and it is waiting for a Sentinel administrator to approve it. Nothing is blocked yet.";
    case "REFUSED":
      return `Sentinel refused the containment action: ${reason ?? "a rail refused it."}`;
    case "FAILED":
      return "Sentinel could not be reached. Nothing was blocked.";
    case "REQUESTED":
      return "The containment request is in flight.";
    case "NONE":
      return "No containment has been asked for.";
  }
}
