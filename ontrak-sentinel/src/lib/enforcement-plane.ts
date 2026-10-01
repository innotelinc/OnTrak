import type {
  EnforcementActionRecord,
  RollbackPlan,
} from "./enforcement-service.js";

/**
 * The enforcement plane (S4): the seam that turns an `ACTIVE` record into a
 * filtered packet at something that can actually drop one.
 *
 * Everything up to here decided, approved, recorded and audited an action, and
 * deliberately touched no network ([`enforcement-rules.ts`](./enforcement-rules.ts),
 * [`enforcement-service.ts`](./enforcement-service.ts)). This module is the other
 * half, and it is written as an **interface plus two implementations** for the same
 * reason every telemetry source and every other vendor seam in this product is: an
 * IPS that shipped its own packet filter would be a detection platform pretending to
 * be a firewall, and the deployment that has a firewall already has a way to talk to
 * it.
 *
 * `EnforcementTarget` is the whole contract a plane needs — an address, an identity
 * or a device — so a plane never learns anything about Sentinel's records beyond the
 * action and what it names. What a plane is *given* is the record as stored: the
 * action, the targets, the reason, the alert behind it and the actor who was
 * accountable, because a firewall's own log is evidence only if it can be joined
 * back to the decision that put the block there.
 *
 * Three properties are the interface's, not an implementation's:
 *
 *   * **A plane never throws.** `apply`/`lift` answer with an outcome, because a
 *     firewall being unreachable is not a reason for an operator's approval to
 *     disappear. The service records the refusal and leaves the record `ACTIVE` —
 *     the action is what was decided and approved, and a plane that could not be
 *     reached is a fact about the plane.
 *   * **Lifting is not optional either.** A plane that was handed a block must be
 *     told when it ends, or a TTL is a promise made on paper only. The service calls
 *     `lift` on the hand lift and on the expiry sweep alike, from the record's own
 *     stored rollback plan.
 *   * **There is no plane by default.** A deployment with none configured behaves
 *     exactly as it did before this module existed: every action is one an operator
 *     can take and undo, and nothing claims a packet was filtered when none was.
 */

/** What a plane answered. A refusal is data, not an exception. */
export type PlaneOutcome =
  | { ok: true; detail: string }
  | { ok: false; error: string };

/** What a plane is told. Deliberately the record itself, not a summary of it. */
export interface EnforcementPlane {
  /** Named in the evidence chain, so a reader can tell which plane was told. */
  readonly name: string;
  /** Put an action in force. */
  apply(record: EnforcementActionRecord): Promise<PlaneOutcome>;
  /** Take an action back out, from the plan computed when it was decided. */
  lift(record: EnforcementActionRecord, plan: RollbackPlan): Promise<PlaneOutcome>;
}

/**
 * A plane that keeps what it was told, and does nothing with it.
 *
 * Two real uses, and neither is a placeholder. It is the plane a **deployment that
 * wants the seam exercised without a firewall** runs — the console and the chain then
 * say an action reached a plane and what that plane was told, which is what a
 * dry run is for. And it is the plane a test drives, so "the service calls the plane
 * on an `ACTIVE` record and on a lift" is asserted rather than described.
 *
 * It answers `ok` on purpose: it *did* do what it was asked, which was to record.
 * A deployment that wants to be told its plane is a no-op names it as one.
 */
export class RecordingEnforcementPlane implements EnforcementPlane {
  readonly name: string;
  readonly applied: EnforcementActionRecord[] = [];
  readonly lifted: { action: EnforcementActionRecord; plan: RollbackPlan }[] = [];

  constructor(name = "recording") {
    this.name = name;
  }

  async apply(record: EnforcementActionRecord): Promise<PlaneOutcome> {
    this.applied.push(record);
    return { ok: true, detail: `recorded ${record.action} on ${record.targets.length} target(s)` };
  }

  async lift(record: EnforcementActionRecord, plan: RollbackPlan): Promise<PlaneOutcome> {
    this.lifted.push({ action: record, plan });
    return { ok: true, detail: `recorded ${plan.kind} on ${plan.targets.length} target(s)` };
  }
}

export interface HttpEnforcementPlaneOptions {
  /** The plane's one endpoint. Every call is a `POST` to it. */
  url: string;
  /** A bearer token, when the plane wants one. Sent only when set. */
  token?: string;
  /** How long to wait before treating the plane as unreachable. */
  timeoutMs?: number;
  /** Injected only by a test. */
  fetchImpl?: typeof fetch;
}

/**
 * A plane that speaks HTTP: one `POST` per operation, JSON in and JSON out.
 *
 * One endpoint rather than a REST vocabulary of its own, because the plane is a
 * *deployment's* adapter and the shape it needs is the one it already has. The body is
 * `{ op, action, plan? }` and the answer is believed only when it is a 2xx with
 * `{ ok: true }` — anything else, including a timeout, a DNS failure and a body that
 * is not JSON, is an outcome the chain records rather than an exception that would
 * take the operator's approval down with it.
 */
export class HttpEnforcementPlane implements EnforcementPlane {
  readonly name: string;
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpEnforcementPlaneOptions) {
    this.url = options.url;
    this.token = options.token ?? "";
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    // The host is enough to identify the plane in an audit row and short enough not
    // to put a path (which may name a tenant) into every entry.
    try {
      this.name = `http:${new URL(this.url).host}`;
    } catch {
      this.name = "http";
    }
  }

  apply(record: EnforcementActionRecord): Promise<PlaneOutcome> {
    return this.send({ op: "apply", action: record });
  }

  lift(record: EnforcementActionRecord, plan: RollbackPlan): Promise<PlaneOutcome> {
    return this.send({ op: "lift", action: record, plan });
  }

  private async send(body: unknown): Promise<PlaneOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token === "" ? {} : { authorization: `Bearer ${this.token}` }),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (!response.ok) {
        // The plane's own words when it sent any: a 4xx body is usually the only
        // thing that says *why* a target was rejected, and replacing it with "HTTP
        // 400" would throw away the answer.
        return { ok: false, error: `plane answered ${response.status}${text === "" ? "" : `: ${text.slice(0, 200)}`}` };
      }
      if (typeof parsed === "object" && parsed !== null && (parsed as { ok?: unknown }).ok === false) {
        const reason = (parsed as { error?: unknown }).error;
        return { ok: false, error: typeof reason === "string" && reason !== "" ? reason : "plane refused" };
      }
      return { ok: true, detail: `plane answered ${response.status}` };
    } catch (error) {
      // Abort, DNS, TLS, a connection refused: one outcome, because they are one
      // fact to the operator — the plane did not answer.
      const detail = error instanceof Error ? error.message : "unknown error";
      return { ok: false, error: `plane unreachable: ${detail}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The plane a deployment's environment describes, or `null` for none.
 *
 * Read here rather than in the service so the seam stays testable without an
 * environment: the service takes an `EnforcementPlane`, and this is only how a
 * process decides which one. An unset URL is **no plane** rather than a default that
 * pretends — a deployment that has not configured one must not be told its blocks
 * are being applied somewhere.
 */
export function planeFromEnv(env: NodeJS.ProcessEnv = process.env): EnforcementPlane | null {
  const url = String(env.SENTINEL_ENFORCEMENT_PLANE_URL ?? "").trim();
  if (url === "") return null;
  const token = String(env.SENTINEL_ENFORCEMENT_PLANE_TOKEN ?? "").trim();
  const timeout = Number(env.SENTINEL_ENFORCEMENT_PLANE_TIMEOUT_MS ?? "");
  return new HttpEnforcementPlane({
    url,
    ...(token === "" ? {} : { token }),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
  });
}
