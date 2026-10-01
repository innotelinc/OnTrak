import { config, isPlaceholderSecret } from "./config.js";

/**
 * Distro's control plane, as Genie consumes it.
 *
 * Genie is single-tenant in the ways that cost money: it holds **one** gateway
 * key in `.env`, resolves it server-side, and has no per-identity attribution or
 * quota. Distro's control plane already solved exactly that, and OmniRoute
 * accounts per **API key**, so mapping `user ↔ gateway_key` gives attribution and
 * enforcement without the gateway being touched.
 *
 * Three calls, and each has one job:
 *
 *   identity   → `sub` + email in, account + that user's gateway key out
 *                (service-to-service; `x-control-internal-token`)
 *   quota      → the user's gateway key in, allow/deny out (bearer = gateway key,
 *                which is how the control plane identifies the account)
 *   audit      → a row for an action that touches a public name or another
 *                system on the deployment's behalf
 *
 * Nothing here ever hands the gateway key to the browser: the server calls these
 * from request handlers only, and the turn it authorises spends the key without
 * the console ever seeing it.
 *
 * This is a deliberate port of Studio's module of the same name, and the wire
 * contract is Studio's — the same endpoints, headers and payload names, so one
 * control plane serves both surfaces and neither grows its own dialect.
 * Configuration is `CONTROL_PLANE_INTERNAL_URL` + `CONTROL_INTERNAL_TOKEN`. With
 * neither set the whole module is inert and Genie behaves as the single-operator
 * tool it has been — see `src/tenancy.ts` for what that means per turn.
 */

export type ControlPlaneConfig = {
  url: string;
  token: string;
};

export type QuotaSnapshot = {
  plan: string;
  requestsPerDay: number | null;
  tokensPerDay: number | null;
  spendCapUsd: number | null;
};

export type UsageSnapshot = {
  tokensIn: number;
  tokensOut: number;
  requests: number;
  costUsd: number;
  date: string;
};

/** The account a caller resolves to, with the key that pays for their turns. */
export type PlaneIdentity = {
  /** The control-plane user id — what the account is keyed on there. */
  userId: string;
  sub: string;
  email: string;
  /** This user's own gateway key. Server-side only. */
  gatewayKey: string;
  /** True when this call created the account (it did not exist before). */
  created: boolean;
  quota: QuotaSnapshot | null;
  usageToday: UsageSnapshot | null;
};

export type QuotaDecision = {
  allowed: boolean;
  reasons: string[];
};

/** A control-plane call that failed. `status` is the plane's when it answered. */
export class ControlPlaneError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The configured control plane, or null when this deployment has none.
 *
 * A placeholder token is treated as unconfigured: `.env.example` ships an empty
 * one, and reading a placeholder as a credential would turn a fresh checkout into
 * a console that refuses every turn for a reason no log explains.
 */
export function readControlPlaneConfig(): ControlPlaneConfig | null {
  const url = config.controlPlaneUrl.trim();
  const token = config.controlToken.trim();
  if (url === "" || isPlaceholderSecret(token)) return null;

  return { url: url.replace(/\/+$/, ""), token };
}

export function controlPlaneEnabled(): boolean {
  return readControlPlaneConfig() !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseQuota(value: unknown): QuotaSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const record = asRecord(value);
  return {
    plan: asString(record.plan) || "free",
    requestsPerDay: asNumber(record.requests_per_day),
    tokensPerDay: asNumber(record.tokens_per_day),
    spendCapUsd: asNumber(record.spend_cap_usd),
  };
}

function parseUsage(value: unknown): UsageSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const record = asRecord(value);
  return {
    tokensIn: asNumber(record.tokens_in) ?? 0,
    tokensOut: asNumber(record.tokens_out) ?? 0,
    requests: asNumber(record.requests) ?? 0,
    costUsd: asNumber(record.cost_usd) ?? 0,
    date: asString(record.date),
  };
}

/**
 * One JSON call to the control plane.
 *
 * The error message never echoes the request headers: one of them is a
 * credential (either the service token or the user's gateway key), and a message
 * that carries it ends up in a log line and eventually in a bug report.
 */
async function call(
  config: ControlPlaneConfig,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: unknown },
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${config.url}${path}`, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        // Node's fetch keeps no cache of its own, but a proxy in front of the
        // plane would, and an identity or quota answer that is even a minute old
        // is a decision made about somebody else's account.
        "cache-control": "no-store",
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new ControlPlaneError(`Could not reach the tenancy service at ${config.url} (${detail}).`);
  }

  const text = await response.text().catch(() => "");
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const reason = asString(asRecord(payload).error) || `HTTP ${response.status}`;
    throw new ControlPlaneError(`The tenancy service refused that call: ${reason}.`, response.status);
  }

  return asRecord(payload);
}

/**
 * Resolve an identity to an account and that account's gateway key.
 *
 * Idempotent on the control-plane side: the account is created (with its own
 * gateway key) the first time a subject is seen and returned unchanged after
 * that. A `409` means the email is already bound to a *different* subject — a
 * conflict an operator has to resolve, never something to paper over by creating
 * a second account for one human.
 */
export async function provisionIdentity(
  plane: ControlPlaneConfig,
  input: { sub: string; email: string; name?: string },
): Promise<PlaneIdentity> {
  const payload = await call(plane, "/api/internal/identity", {
    method: "POST",
    headers: { "x-control-internal-token": plane.token },
    body: { sub: input.sub, email: input.email, name: input.name },
  });

  const user = asRecord(payload.user);
  const gatewayKey = asString(payload.gatewayKey);
  if (!gatewayKey) {
    throw new ControlPlaneError("The tenancy service did not return a gateway key for this account.");
  }

  return {
    userId: asString(user.id),
    sub: asString(payload.oidcSub) || input.sub,
    email: asString(user.email) || input.email,
    gatewayKey,
    created: payload.created === true,
    quota: parseQuota(payload.quota),
    usageToday: parseUsage(payload.usageToday),
  };
}

/**
 * Pre-flight quota gate, called once per turn before anything is spent.
 *
 * The control plane identifies the account by the gateway key itself, so the
 * user's own key is the credential here — no session token leaves this process.
 */
export async function checkTurnQuota(
  plane: ControlPlaneConfig,
  gatewayKey: string,
): Promise<QuotaDecision> {
  const payload = await call(plane, "/api/internal/quota-check", {
    method: "GET",
    headers: { authorization: `Bearer ${gatewayKey}` },
  });

  const reasons = Array.isArray(payload.reasons)
    ? payload.reasons.filter((reason): reason is string => typeof reason === "string")
    : [];

  return { allowed: payload.allowed === true, reasons };
}

/**
 * Record a finished turn.
 *
 * Best-effort on purpose: the turn has already been paid for, and failing it
 * after the fact would trade a small accounting gap for a broken answer. The
 * gateway key's own hard caps remain the backstop.
 */
export async function reportTurnUsage(
  plane: ControlPlaneConfig,
  gatewayKey: string,
  usage: { tokensIn: number; tokensOut: number; requests: number; model?: string },
): Promise<void> {
  try {
    await call(plane, "/api/internal/usage-report", {
      method: "POST",
      headers: { authorization: `Bearer ${gatewayKey}` },
      body: {
        tokensIn: Math.max(0, Math.round(usage.tokensIn) || 0),
        tokensOut: Math.max(0, Math.round(usage.tokensOut) || 0),
        requests: Math.max(1, Math.round(usage.requests) || 1),
        model: usage.model ? usage.model.slice(0, 200) : undefined,
      },
    });
  } catch {
    // Deliberately swallowed (and not logged with the key): see above.
  }
}

/**
 * The action worth an audit row here.
 *
 * The control plane's vocabulary is shared with Studio's, and this is the one of
 * them this console performs: an export leaves the workspace and becomes another
 * system's input. Declaring only what is sent keeps the two from drifting.
 */
export type AuditAction = "build.export";

/**
 * Write one audit row.
 *
 * Best-effort for the same reason as usage: an audit row that could not be
 * written must not be the thing that fails an export the user already made.
 */
export async function recordAudit(
  plane: ControlPlaneConfig,
  event: {
    action: AuditAction;
    sub?: string;
    actorEmail?: string;
    targetId?: string;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await call(plane, "/api/internal/audit", {
      method: "POST",
      headers: { "x-control-internal-token": plane.token },
      body: {
        action: event.action,
        sub: event.sub,
        actorEmail: event.actorEmail,
        targetId: event.targetId,
        meta: event.meta,
      },
    });
  } catch {
    // See reportTurnUsage.
  }
}

/**
 * The outage this process lived through and has not yet been able to report.
 *
 * A control plane that is unreachable cannot be told about its own outage while
 * it is happening: the caller is the only witness and it is the one that cannot
 * get through. Left alone, that window leaves no trace on either side — the user
 * sees a refused turn and the operator sees nothing. So it is recorded here and
 * reported to the plane on the next call that succeeds, or by the timer
 * `server.ts` arms whenever tenancy is on.
 */
export type PendingOutage = {
  /** First failed call, and last — the window the operator should read. */
  since: number;
  until: number;
  /** How many calls failed in the window, so one alert stands for all of them. */
  failedCalls: number;
  /** The last failure's own words, which name the actual fault. */
  detail: string;
};

let pendingOutage: PendingOutage | null = null;

/** Record a failed call. Repeated failures extend one window rather than piling up. */
export function noteControlPlaneOutage(detail: string, now: number = Date.now()): void {
  if (pendingOutage === null) {
    pendingOutage = { since: now, until: now, failedCalls: 1, detail };
    return;
  }
  pendingOutage.until = now;
  pendingOutage.failedCalls += 1;
  pendingOutage.detail = detail;
}

/** The recorded window, or null. Exported so a caller can log or test it. */
export function pendingControlPlaneOutage(): PendingOutage | null {
  return pendingOutage;
}

/** Only for tests: a pending outage would leak between cases. */
export function resetControlPlaneOutage(): void {
  pendingOutage = null;
}

/**
 * Report a recorded outage to the operator, best-effort.
 *
 * Called after any successful call and on a timer; both are cheap because there
 * is usually nothing pending. Delivery is *not* retried past the next attempt and
 * is cleared only on success, so an outage is reported once — the plane's own
 * cooldown (`CONTROL_ALERT_COOLDOWN_MS`) is what keeps a burst to one alert, not
 * a queue here that outlives the fault.
 */
export async function reportControlPlaneOutage(plane: ControlPlaneConfig): Promise<void> {
  if (pendingOutage === null) return;
  const outage = pendingOutage;
  try {
    await call(plane, "/api/internal/alert", {
      method: "POST",
      headers: { "x-control-internal-token": plane.token },
      body: {
        event: "controlplane.unreachable",
        title: "Genie could not reach the tenancy service",
        message:
          `${outage.failedCalls} tenancy call(s) failed between ${new Date(outage.since).toISOString()} ` +
          `and ${new Date(outage.until).toISOString()}; the last said: ${outage.detail}`,
        meta: {
          since: new Date(outage.since).toISOString(),
          until: new Date(outage.until).toISOString(),
          failedCalls: outage.failedCalls,
        },
      },
    });
    pendingOutage = null;
  } catch {
    // Still unreachable, or the report itself was refused — keep the window for
    // the next attempt rather than dropping the only record of the outage.
  }
}
