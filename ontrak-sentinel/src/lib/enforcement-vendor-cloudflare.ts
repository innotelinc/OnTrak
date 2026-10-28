import type { RollbackPlan } from "./enforcement-rules.js";
import type { EnforcementPlane, PlaneOutcome } from "./enforcement-plane.js";
import type { EnforcementActionRecord } from "./enforcement-service.js";

/**
 * A real vendor behind the enforcement plane: **Cloudflare IP Access Rules** (2.1).
 *
 * The seam (`enforcement-plane.ts`) ended at an operator-written JSON `POST`, and that was
 * the right first shape — a plane should not be a packet filter pretending to be one. But
 * "the operator writes the adapter" was also where 2.0 stopped, and a deployment that
 * already runs Cloudflare should not have to write forty lines to block an address that
 * Sentinel has already decided, approved and audited.
 *
 * So this is a vendor adapter, and three decisions make it a seam rather than a second
 * product:
 *
 *   * **It is the same `EnforcementPlane` and nothing more.** It is handed the stored record
 *     and answers with an outcome. It holds no policy, re-decides nothing, and never throws:
 *     a Cloudflare 403 is an outcome the chain records as `enforcement.plane.failed` while
 *     the action stays `ACTIVE`, exactly as an unreachable generic plane does.
 *   * **It only says what the vendor can express.** Access rules block an address or a
 *     range. An action naming an `IDENTITY` or a `DEVICE` is refused *before* anything is
 *     dialled, because half-applying an action and calling it applied is worse than a
 *     refusal that says which target it could not reach. The refusal names the target.
 *   * **A lift has to find what it blocked.** The rule id the API returns is remembered for
 *     the life of the process, and a lift that does not remember one looks the rule up by
 *     the note written at block time (`sentinel:<action id>`). A restart therefore loses the
 *     cache, not the ability to undo — which is what keeps a TTL a promise rather than a
 *     note on a record.
 *
 * The note is the join back to the decision: `sentinel:<action id>` is what ties a row in
 * Cloudflare's own log to the alert, the approver and the evidence chain that put it there.
 * It deliberately carries no address (the rule already does) and no reason (that is the
 * register's, not a third party's, to publish).
 */

/** Where Cloudflare's API lives. A deployment on a proxy or a test points elsewhere. */
const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";

/** How much of the vendor's own words are kept. Same budget the generic plane uses. */
const MAX_VENDOR_ERROR = 200;

export interface CloudflareEnforcementOptions {
  /** A scoped API token that may edit firewall access rules. Never logged or echoed. */
  token: string;
  /** The Cloudflare account the rules belong to. */
  accountId: string;
  /** `CLOUDFLARE_API_BASE`; a test points it at a local stub. */
  apiBase?: string;
  /** How long to wait before treating Cloudflare as unreachable. */
  timeoutMs?: number;
  /** Injected only by a test. */
  fetchImpl?: typeof fetch;
}

/** Where a rule id is remembered: one action may name more than one address. */
function ruleKey(actionId: string, value: string): string {
  return `${actionId}\u0000${value.trim().toLowerCase()}`;
}

interface RuleRecord {
  id: string;
  configuration?: { target?: string; value?: string };
  notes?: string;
}

/** What a Cloudflare call answered. `missing` is a 404, which a lift reads as "already gone". */
type Sent =
  | { ok: true; value: unknown }
  | { ok: false; error: string; missing: boolean };

export class CloudflareEnforcementPlane implements EnforcementPlane {
  readonly name: string;
  private readonly token: string;
  private readonly accountId: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** action id + address → the rule Cloudflare told us it wrote. */
  private readonly rules = new Map<string, string>();

  constructor(options: CloudflareEnforcementOptions) {
    this.token = options.token;
    this.accountId = options.accountId;
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    // The account, not the token: a name that a log line or an audit row can carry.
    this.name = `cloudflare:${options.accountId}`;
  }

  async apply(record: EnforcementActionRecord): Promise<PlaneOutcome> {
    const targets = record.targets;
    const unsupported = targets.find((target) => target.kind !== "ADDRESS");
    if (unsupported !== undefined) {
      return {
        ok: false,
        error:
          `Cloudflare access rules block an address or a range, and this action also names ` +
          `${unsupported.kind} “${unsupported.value}”. Nothing was sent: an action sent in part ` +
          `is not the action that was approved.`,
      };
    }
    if (targets.length === 0) {
      return { ok: false, error: "This action names no address, so Cloudflare has nothing to block." };
    }

    let blocked = 0;
    for (const target of targets) {
      const sent = await this.send("POST", this.rulesPath(), {
        // `ip` and `ip_range` are the vendor's two address shapes; the value already says
        // which one this is.
        mode: "block",
        notes: `sentinel:${record.id}`,
        configuration: {
          target: target.value.includes("/") ? "ip_range" : "ip",
          value: target.value,
        },
      });
      if (!sent.ok) {
        return {
          ok: false,
          error:
            `${blocked} of ${targets.length} address(es) blocked; “${target.value}” was refused: ` +
            sent.error,
        };
      }
      const rule = ruleOf(sent.value);
      if (rule === null) {
        return {
          ok: false,
          error:
            `Cloudflare answered for “${target.value}” without a rule id, so the block cannot ` +
            `be lifted later; ${blocked} address(es) were blocked.`,
        };
      }
      this.rules.set(ruleKey(record.id, target.value), rule);
      blocked += 1;
    }

    return {
      ok: true,
      detail: `blocked ${blocked} address(es) with Cloudflare access rules (${this.name})`,
    };
  }

  async lift(record: EnforcementActionRecord, plan: RollbackPlan): Promise<PlaneOutcome> {
    const targets = (plan.targets.length > 0 ? plan.targets : record.targets).filter(
      (target) => target.kind === "ADDRESS",
    );
    // An identity or a device never reached Cloudflare, so there is nothing there to release.
    if (targets.length === 0) {
      return {
        ok: true,
        detail: "Cloudflare blocked no address for this action, so there was nothing to lift.",
      };
    }

    let lifted = 0;
    for (const target of targets) {
      const remembered = this.rules.get(ruleKey(record.id, target.value));
      const found = remembered === undefined
        ? await this.rulesByNotes(record.id, target.value)
        : ({ ok: true, value: [remembered] } as const);
      if (!found.ok) {
        return { ok: false, error: `${target.value}: ${found.error}` };
      }
      if (found.value.length === 0) continue;

      for (const id of found.value) {
        const deleted = await this.send(
          "DELETE",
          `${this.rulesPath()}/${encodeURIComponent(id)}`,
        );
        // A rule that is already gone is the outcome a lift wants; a sweep that runs twice
        // must not report a failure for having done its job once.
        if (!deleted.ok && !deleted.missing) {
          return { ok: false, error: `rule ${id} for ${target.value} could not be removed: ${deleted.error}` };
        }
        this.rules.delete(ruleKey(record.id, target.value));
        lifted += 1;
      }
    }

    return {
      ok: true,
      detail:
        lifted === 0
          ? "Cloudflare had no rule left to lift for this action"
          : `lifted ${lifted} Cloudflare access rule(s) (${this.name})`,
    };
  }

  /**
   * The rule ids Cloudflare holds for an action, asked by the note written at block time.
   *
   * This is what a restart falls back on: the process forgot the ids, Cloudflare did not
   * forget the rules. Filtering by the address as well as the note matters when an action
   * named several targets — the action id alone would lift all of them from one target's
   * loop.
   */
  private async rulesByNotes(
    actionId: string,
    value: string,
  ): Promise<{ ok: true; value: string[] } | { ok: false; error: string }> {
    const query = `?notes=${encodeURIComponent(`sentinel:${actionId}`)}&per_page=100`;
    const sent = await this.send("GET", `${this.rulesPath()}${query}`);
    if (!sent.ok) return { ok: false, error: sent.error };

    const wanted = value.trim().toLowerCase();
    const rules = Array.isArray(sent.value) ? (sent.value as RuleRecord[]) : [];
    const ids = rules
      .filter(
        (rule) =>
          typeof rule?.id === "string" &&
          (rule.configuration?.value ?? "").trim().toLowerCase() === wanted,
      )
      .map((rule) => rule.id);
    return { ok: true, value: ids };
  }

  /** The collection, relative to the API base — `send` prepends the base once. */
  private rulesPath(): string {
    return `/accounts/${encodeURIComponent(this.accountId)}/firewall/access_rules/rules`;
  }

  /**
   * One call, answered rather than thrown.
   *
   * A refusal is the vendor's own words where it sent any (a 4xx body is usually the only
   * thing that says *why* an address was rejected), truncated because an HTML error page is
   * not an audit detail. The bearer token is never included in a message — it is not in the
   * response body, and nothing here echoes the request.
   */
  private async send(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<Sent> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {
        parsed = null;
      }
      const payload = parsed as
        | { success?: unknown; result?: unknown; errors?: unknown }
        | null;

      if (!response.ok) {
        return {
          ok: false,
          error: `Cloudflare answered ${response.status}${detailSuffix(payload, text)}`,
          missing: response.status === 404,
        };
      }
      // Cloudflare uses a 200 with `success: false` for a refusal; believing the status
      // alone would report a rule that was never written.
      if (payload !== null && payload.success === false) {
        return { ok: false, error: vendorError(payload, text, response.status), missing: false };
      }
      return { ok: true, value: payload?.result ?? null };
    } catch (error) {
      // Abort, DNS, TLS and a refused connection are one fact to the operator.
      const detail = error instanceof Error ? error.message : "unknown error";
      return { ok: false, error: `Cloudflare unreachable: ${detail}`, missing: false };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * A plane this deployment asked for and cannot use.
 *
 * Deliberately a plane rather than `null`: an operator who names a vendor and mistypes a
 * variable must not be shown the same startup line as one who configured nothing. Every
 * call answers with the reason, so the evidence chain carries `enforcement.plane.failed`
 * naming the misconfiguration instead of a silence that looks like "nothing to do".
 */
export class MisconfiguredVendorPlane implements EnforcementPlane {
  readonly name: string;
  constructor(name: string, private readonly reason: string) {
    this.name = name;
  }

  async apply(): Promise<PlaneOutcome> {
    return { ok: false, error: this.reason };
  }

  async lift(): Promise<PlaneOutcome> {
    return { ok: false, error: this.reason };
  }
}

/**
 * The vendor plane this environment names, or `null` when it names none.
 *
 * A vendor outranks `SENTINEL_ENFORCEMENT_PLANE_URL`: the two are different answers to the
 * same question, and the vendor is the more specific one. A name that is set but incomplete
 * still produces a plane — one that refuses, loudly, rather than pretending the deployment
 * has no enforcement at all.
 */
export function vendorPlaneFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EnforcementPlane | null {
  const vendor = String(env.SENTINEL_ENFORCEMENT_VENDOR ?? "").trim();
  if (vendor === "") return null;

  if (vendor.toLowerCase() !== "cloudflare") {
    return new MisconfiguredVendorPlane(
      `vendor:${vendor.toLowerCase()}`,
      `SENTINEL_ENFORCEMENT_VENDOR=${vendor} is not a vendor this build ships ` +
        `(it ships cloudflare). Nothing is being filtered until one is configured.`,
    );
  }

  const token = String(env.CLOUDFLARE_API_TOKEN ?? "").trim();
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const missing = [
    ...(token === "" ? ["CLOUDFLARE_API_TOKEN"] : []),
    ...(accountId === "" ? ["CLOUDFLARE_ACCOUNT_ID"] : []),
  ];
  if (missing.length > 0) {
    return new MisconfiguredVendorPlane(
      "cloudflare",
      `cloudflare enforcement is named but ${missing.join(" and ")} ` +
        `${missing.length === 1 ? "is" : "are"} unset, so no access rule can be written.`,
    );
  }

  const apiBase = String(env.CLOUDFLARE_API_BASE ?? "").trim();
  const timeout = Number(env.SENTINEL_ENFORCEMENT_PLANE_TIMEOUT_MS ?? "");
  return new CloudflareEnforcementPlane({
    token,
    accountId,
    ...(apiBase === "" ? {} : { apiBase }),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
  });
}

/** The rule id in a create answer, or `null` when the vendor sent no usable one. */
function ruleOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** Cloudflare's `errors[].message`, which is the part that says why a rule was refused. */
function vendorError(
  payload: { errors?: unknown } | null,
  text: string,
  status: number,
): string {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const messages: string[] = [];
  for (const entry of errors) {
    const message = typeof entry === "object" && entry !== null
      ? (entry as { message?: unknown }).message
      : null;
    if (typeof message === "string" && message.trim() !== "") messages.push(message.trim());
  }
  if (messages.length > 0) return messages.join("; ").slice(0, MAX_VENDOR_ERROR);
  const body = text.trim();
  return body === "" ? `Cloudflare refused with status ${status}` : body.slice(0, MAX_VENDOR_ERROR);
}

/**
 * The `: <vendor's words>` half of a status refusal.
 *
 * Kept separate from `vendorError` because a 404 from a delete has no body worth quoting and
 * no errors to join — the status alone is the whole fact, and inventing a sentence for it
 * would put words in the vendor's mouth.
 */
function detailSuffix(payload: { errors?: unknown } | null, text: string): string {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const messages: string[] = [];
  for (const entry of errors) {
    const message = typeof entry === "object" && entry !== null
      ? (entry as { message?: unknown }).message
      : null;
    if (typeof message === "string" && message.trim() !== "") messages.push(message.trim());
  }
  if (messages.length > 0) return `: ${messages.join("; ").slice(0, MAX_VENDOR_ERROR)}`;
  const body = text.trim();
  return body === "" ? "" : `: ${body.slice(0, MAX_VENDOR_ERROR)}`;
}
