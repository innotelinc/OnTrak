import { config } from "./config.js";
import {
  ControlPlaneError,
  checkTurnQuota,
  controlPlaneEnabled,
  noteControlPlaneOutage,
  provisionIdentity,
  readAccountUsage,
  readControlPlaneConfig,
  reportControlPlaneOutage,
  reportTurnUsage,
  type AccountUsage,
  type ControlPlaneConfig,
} from "./controlplane.js";
import { ceilingFor, ceilingMessage, noteTurn, type Ceiling } from "./ceiling.js";
import type { Session } from "./oidc.js";
import { accountScope, defaultScope, type Scope } from "./scope.js";

/**
 * The per-turn tenancy gate: whose key pays, whether they may spend, and what
 * gets recorded.
 *
 * Before this, every turn spent the one `OMNIROUTE_API_KEY` in `.env`: no
 * attribution, no per-user quota, no way to tell two users apart in the
 * gateway's ledger. Now a turn resolves the signed-in person to a control-plane
 * account and spends **that account's** key, which is what makes quota and usage
 * real. The contract itself is Distro's, and Genie speaks it as Studio does —
 * `src/controlplane.ts` has the endpoints.
 *
 * What is strict and what is not, deliberately:
 *
 *   * **The key is strict.** With a control plane configured, a turn without a
 *     resolved account is refused — no quiet fallback to the shared `.env` key.
 *     A fallback would move one person's spend onto the operator's key, which is
 *     the exact problem this replaces. It also means tenancy needs sign-in: the
 *     control plane keys accounts on the OIDC `sub`, and a shared bearer carries
 *     no subject to key on.
 *   * **The quota check is fail-open.** A control plane that cannot answer does
 *     not stop somebody from working; the gateway key's own hard caps remain the
 *     backstop (the same posture Studio takes).
 *   * **Accounting is best-effort.** A turn that has already been paid for must
 *     not fail because the ledger write did.
 *   * **The ceiling is strict, and it is Genie's own.** The plane rents nothing
 *     here — the family runs on unlimited usage — so the only bound on a runaway
 *     loop is the one this console keeps itself (`AGENT_ACCOUNT_CEILING_REQUESTS`,
 *     `src/ceiling.ts`). It is counted in the gate that spends, so nothing reaches
 *     the model without passing it, and it is deliberate that a restart clears it:
 *     a durable count would be a bill in disguise.
 *
 * With no control plane configured, none of this applies and Genie is the
 * single-operator tool it has been — see `readControlPlaneConfig`. That includes
 * an **empty** `OMNIROUTE_API_KEY`: a gateway on this host may need no key at
 * all, which is the shipped default, so an empty shared key is a real setting
 * rather than a missing one.
 *
 * The gate returns data (`status` + `message`) rather than a `Response`: this
 * module knows nothing about HTTP, and the server turns a refusal into the same
 * JSON error shape it sends for everything else.
 */

export type Caller = {
  /** The control-plane user id, as the plane knows this person. */
  userId: string;
  sub: string;
  email: string;
  /** This user's own gateway key. Server-side only; never sent to the browser. */
  gatewayKey: string;
  /** True when this call created the account in the control plane. */
  created: boolean;
};

export type Turn = {
  /** The key this turn spends: the caller's own, or the shared one when unconfigured. */
  apiKey: string;
  /** The account paying for it, or null in single-operator mode. */
  caller: Caller | null;
};

export type TurnStarted = { ok: true; turn: Turn } | { ok: false; status: number; message: string };

/** What a turn cost, accumulated from the gateway's own usage reports. */
export type TurnUsage = {
  tokensIn: number;
  tokensOut: number;
  requests: number;
  model?: string;
};

/**
 * In-process cache, so a chat that reconnects does not re-provision on every
 * request. Short enough that a revoked account stops working promptly: the
 * identity answer is a routing decision, but the *quota* decision is re-checked
 * per turn and is never cached.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; sub: string; caller: Caller } | null = null;

/** Only for tests: a cached caller would leak between cases. */
export function resetCallerCache(): void {
  cache = null;
}

/**
 * Resolve a signed-in person to an account, or null when this deployment has no
 * control plane.
 *
 * Throws (`ControlPlaneError`) when the plane is configured and cannot answer: a
 * configured-but-broken tenancy service must be loud, not silently replaced by
 * an unattributed shared key.
 */
export async function resolveCaller(
  session: Session,
  plane: ControlPlaneConfig | null = readControlPlaneConfig(),
): Promise<Caller | null> {
  const sub = session.sub.trim();
  if (plane === null || sub === "") return null;

  if (cache !== null && cache.sub === sub && Date.now() - cache.at < CACHE_TTL_MS) return cache.caller;

  const identity = await provisionIdentity(plane, {
    sub,
    email: session.email.trim(),
    name: session.name.trim(),
  });

  const caller: Caller = {
    userId: identity.userId,
    sub,
    email: identity.email,
    gatewayKey: identity.gatewayKey,
    created: identity.created,
  };

  cache = { at: Date.now(), sub, caller };
  return caller;
}

/**
 * Resolve the caller and the key that pays for this turn.
 *
 * Called at the top of the model route, after authorization and before anything
 * is spent, so identity and money are decided in one place instead of two that
 * drift.
 */
/** The refusal a turn gets when tenancy is on and nobody is signed in. */
const NO_ACCOUNT_TURN =
  "Genie cannot tell which account this turn belongs to. Sign in, so the model pool is spent on your own key.";

/** The same refusal for a request that is not a turn: it opens a workspace. */
const NO_ACCOUNT_REQUEST =
  "Genie cannot tell which account this belongs to. Sign in, so you open your own workspace rather than the shared one.";

type Identified = { ok: true; caller: Caller } | { ok: false; status: number; message: string };

/**
 * Who is calling, or why we cannot say.
 *
 * Shared by the turn gate and the request scope so that "which account is this"
 * is answered in exactly one place: two copies of this would be two chances to
 * disagree about what counts as signed in. The wording differs by caller only
 * because the consequence does — a turn spends the model pool, a request opens a
 * directory.
 */
async function identify(
  session: Session | null,
  plane: ControlPlaneConfig,
  messages: { noAccount: string; unreachable: (detail: string) => string },
): Promise<Identified> {
  if (session === null || session.sub.trim() === "") {
    return { ok: false, status: 401, message: messages.noAccount };
  }

  try {
    const caller = await resolveCaller(session, plane);
    if (caller === null) return { ok: false, status: 401, message: messages.noAccount };
    // The plane answered, so anything we failed to report while it was down can
    // go now — this is the one path that knows the outage is over.
    void reportControlPlaneOutage(plane);
    return { ok: true, caller };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    // A 4xx from the plane is a real answer about this person; anything else is
    // the plane being unavailable, which is an outage rather than a verdict —
    // and an outage nobody is told about is exactly what this records.
    const answered =
      error instanceof ControlPlaneError && error.status >= 400 && error.status < 500;
    if (!answered) noteControlPlaneOutage(detail);
    return {
      ok: false,
      status: answered ? (error as ControlPlaneError).status : 503,
      message: messages.unreachable(detail),
    };
  }
}

const TURN_MESSAGES = {
  noAccount: NO_ACCOUNT_TURN,
  unreachable: (detail: string) =>
    `The tenancy service could not identify this account, so the model pool will not be spent: ${detail}`,
};

const REQUEST_MESSAGES = {
  noAccount: NO_ACCOUNT_REQUEST,
  unreachable: (detail: string) =>
    `The tenancy service could not identify this account, so no workspace was opened: ${detail}`,
};

export async function beginTurn(
  session: Session | null,
  /** Overridden only by a test; production always reads the configured plane. */
  plane: ControlPlaneConfig | null = readControlPlaneConfig(),
): Promise<TurnStarted> {
  if (plane === null) {
    // Single-operator: there is no account to attribute to, so the shared key
    // stays the credential and Genie behaves exactly as it did before. An empty
    // one is not an error here — a gateway that needs no key is the default this
    // ships with.
    return { ok: true, turn: { apiKey: config.gatewayKey, caller: null } };
  }

  const who = await identify(session, plane, TURN_MESSAGES);
  if (!who.ok) return who;

  const quota = await checkQuota(plane, who.caller.gatewayKey);
  if (!quota.allowed) {
    const reasons = quota.reasons.length > 0 ? quota.reasons.join(", ") : "quota exhausted";
    return { ok: false, status: 429, message: `Your account cannot start another turn right now — ${reasons}.` };
  }

  // Genie's own ceiling, checked *and* counted here — after the plane has said
  // this account may spend, and before anything does. Counting in the same
  // place that refuses is what makes it impossible to reach the model around.
  const ceiling = ceilingFor(who.caller.userId);
  if (!ceiling.allowed) {
    return { ok: false, status: 429, message: ceilingMessage(ceiling.limit, ceiling.used) };
  }
  noteTurn(who.caller.userId);

  return { ok: true, turn: { apiKey: who.caller.gatewayKey, caller: who.caller } };
}

export type ScopeStarted =
  | { ok: true; scope: Scope }
  | { ok: false; status: number; message: string };

/**
 * The account's slice of disk for a request that is not a turn.
 *
 * Every route that touches the filesystem goes through this, and it is stricter
 * than the turn gate in one way that matters: quota is *not* consulted here. A
 * person at their daily cap may still read the files they already wrote —
 * refusing that would turn a spend limit into a lockout from one's own work —
 * while the thing that costs money stays gated a route later.
 *
 * With no control plane it returns the shared scope, which is the same posture
 * as `beginTurn`: single-operator deployments are untouched.
 */
export async function scopeFor(
  session: Session | null,
  /** Overridden only by a test; production always reads the configured plane. */
  plane: ControlPlaneConfig | null = readControlPlaneConfig(),
): Promise<ScopeStarted> {
  if (plane === null) return { ok: true, scope: defaultScope() };

  const who = await identify(session, plane, REQUEST_MESSAGES);
  if (!who.ok) return who;
  return { ok: true, scope: accountScope(who.caller.userId) };
}

/**
 * The quota decision, fail-open.
 *
 * Exported for its own test: the interesting behaviour is the catch, not the call.
 */
export async function checkQuota(
  plane: ControlPlaneConfig,
  gatewayKey: string,
): Promise<{ allowed: boolean; reasons: string[] }> {
  try {
    return await checkTurnQuota(plane, gatewayKey);
  } catch {
    // The gateway key's own cap is the backstop; a read-only hiccup on the
    // tenancy service must not become an outage for the person using the console.
    return { allowed: true, reasons: [] };
  }
}

/**
 * Add one gateway response's token counts to a running total.
 *
 * The gateway reports usage in the OpenAI shape (`prompt_tokens` /
 * `completion_tokens`); the aliases are accepted because one gateway in front of
 * many providers is exactly where a second spelling turns up, and a ledger that
 * silently counted zero would look like a free month.
 */
export function countUsage(raw: unknown, total: TurnUsage, model?: string): TurnUsage {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

  return {
    tokensIn: total.tokensIn + num(record.prompt_tokens ?? record.input_tokens ?? record.tokens_in),
    tokensOut:
      total.tokensOut + num(record.completion_tokens ?? record.output_tokens ?? record.tokens_out),
    requests: total.requests + 1,
    model: model ?? total.model,
  };
}

/**
 * Record what the turn cost. Best-effort, and never awaited by a user-facing
 * response path that could fail because of it.
 */
export async function finishTurn(turn: Turn, usage: TurnUsage): Promise<void> {
  if (turn.caller === null) return;
  const plane = readControlPlaneConfig();
  if (plane === null) return;
  await reportTurnUsage(plane, turn.caller.gatewayKey, usage);
}

export type AccountUsageRead =
  | { ok: true; email: string; usage: AccountUsage; ceiling: Ceiling }
  | { ok: false; status: number; message: string };

/**
 * What this account has spent, and the caps it is judged by (v0.3).
 *
 * The half a person can act on. The plane already records every turn's cost, so
 * this shows it back beside the account's own ceiling — from the *same* verdict
 * the turn gate reads, so the spend the console reports and the spend that
 * refuses the next turn cannot disagree. It resolves the caller exactly as a turn
 * does, then asks the plane; with no plane there is no account to read.
 */
export async function accountUsage(
  session: Session | null,
  /** Overridden only by a test; production always reads the configured plane. */
  plane: ControlPlaneConfig | null = readControlPlaneConfig(),
): Promise<AccountUsageRead> {
  if (plane === null) {
    return { ok: false, status: 404, message: "this deployment has no control plane to read usage from" };
  }

  const who = await identify(session, plane, REQUEST_MESSAGES);
  if (!who.ok) return who;

  const usage = await readAccountUsage(plane, who.caller.gatewayKey);
  // The plane's number and Genie's own ceiling, read together: the console shows
  // the spend beside the thing that will actually stop it, and a deployment that
  // enforces none says `limit: 0` rather than inventing a bound.
  return { ok: true, email: who.caller.email, usage, ceiling: ceilingFor(who.caller.userId) };
}

/** Whether this deployment resolves and gates turns through the control plane. */
export { controlPlaneEnabled };
