/**
 * Atlas — the ecosystem's forge, as an optional add-on.
 *
 * Atlas (github.com/innotelinc/atlas) is Gitea plus Convex plus the shared
 * OmniRoute gateway: the stack's own home for repositories, reviews and CI. It is
 * **not** Genie's, and this module does not make it so — it holds the two things
 * Genie has to know about it and nothing more:
 *
 *   * **where it is**, from the deployment's environment, so a person does not have
 *     to know an address to use it; and
 *   * **whether the person asking may use it**, because Atlas is an add-on sold
 *     through Magnate, and a subscriber's plan is the thing that grants it.
 *
 * WHO CONNECTS, AND WITH WHAT
 * ---------------------------
 * There are two routes in, and they answer different questions:
 *
 *   1. **The deployment's own credential** (`AGENT_ATLAS_USER` and
 *      `AGENT_ATLAS_PASSWORD`). This is the system path — the operator's own
 *      access, and the reason a plain checkout with no billing configured can use
 *      Atlas directly. It is deliberately *not* gated on a Magnate plan: a
 *      deployment that holds a credential for its own forge is not a subscriber.
 *   2. **The caller's credential**, typed into the console and held for the
 *      session. Atlas verifies it itself — `GET /api/v1/user` is the gate — and
 *      the console asks Magnate for the plan first so a refusal reads as "this is
 *      an add-on, here is where to subscribe" rather than as a login failure for
 *      credentials that were never the problem.
 *
 * The plan is only consulted when Magnate is configured *and* there is a caller to
 * key it on. An unreachable Magnate is not a refusal: it falls back to whether the
 * deployment holds its own credential (see `atlasVerdict`), because breaking the
 * forge for everyone because a billing service hiccupped is not a trade anyone
 * chose.
 */

import { config } from "./config.js";
import { checkEntitlement, EntitlementError, signupUrlFor } from "./entitlements.js";

export interface AtlasInfo {
  /** The forge's base address, e.g. `http://192.168.1.90:3000`. Empty: not configured. */
  url: string;
  /** True when this deployment knows where Atlas is. */
  configured: boolean;
  /**
   * The host a *folder* on Atlas is mounted at, for the SSH form.
   *
   * Empty when the deployment has not said. It is a separate setting from `url`
   * because the forge and the machine are two services that may well be reached by
   * different names — and a mount is an SSH connection, not an HTTP one.
   */
  sshHost: string;
  /** The user this deployment connects to Atlas as, or "". */
  systemUser: string;
  /** True when the deployment holds a credential of its own for Atlas. */
  systemCredential: boolean;
  /** Whether the caller's plan includes Atlas; null when that could not be checked. */
  entitled: boolean | null;
  /** Magnate's or the checker's own words, when there is something to say. */
  reason: string;
  /** Where a person subscribes, when Magnate is configured. */
  signupUrl: string;
}

export function atlasConfigured(): boolean {
  return config.atlasUrl !== "";
}

/** What the console shows about Atlas, and what it may do. */
export async function atlasInfo(user: string | null): Promise<AtlasInfo> {
  const info: AtlasInfo = {
    url: config.atlasUrl,
    configured: atlasConfigured(),
    sshHost: config.atlasSshHost,
    systemUser: config.atlasUser,
    systemCredential: config.atlasUser !== "" && config.atlasPassword !== "",
    entitled: null,
    reason: "",
    signupUrl: signupUrlFor(config.atlasPlan),
  };

  // Nothing to ask: no forge, no caller, or no billing to ask. The plan is a
  // question about a person, and there is no person here without an identity.
  if (!info.configured || user === null || config.magnateEntitlementsUrl === "") return info;

  try {
    const answer = await checkEntitlement({
      plan: config.atlasPlan,
      user,
      unavailable: "Atlas access is unavailable",
    });
    return { ...info, entitled: answer.entitled, reason: answer.reason };
  } catch (error) {
    return {
      ...info,
      entitled: null,
      reason:
        error instanceof EntitlementError
          ? error.message
          : "the Atlas plan could not be checked",
    };
  }
}

export type AtlasVerdict = { ok: true } | { ok: false; message: string };

/**
 * Whether this caller may use Atlas, and the reason they may not.
 *
 * Three answers, in this order, and the order is the policy:
 *
 *   1. the deployment's own credential — always allowed, and the path that makes
 *      Atlas usable on a system deployment with no billing behind it;
 *   2. a plan Magnate says includes Atlas — the subscriber's path;
 *   3. nothing, or a plan that says no — refused, with the signup link when there
 *      is something to subscribe to.
 *
 * A plan that could not be *checked* lands in the third case only when the
 * deployment has no credential of its own to fall back on.
 */
export function atlasVerdict(info: AtlasInfo, usingSystemCredential: boolean): AtlasVerdict {
  if (!info.configured) {
    return { ok: false, message: "Atlas is not configured on this deployment (AGENT_ATLAS_URL)" };
  }
  if (usingSystemCredential) return { ok: true };
  if (info.entitled === true) return { ok: true };

  const where = info.signupUrl === "" ? "" : ` — subscribe at ${info.signupUrl}`;
  if (info.entitled === false) {
    return {
      ok: false,
      message: `Atlas is an add-on and this account's plan does not include it${info.reason ? `: ${info.reason}` : ""}${where}`,
    };
  }
  if (info.systemCredential) return { ok: true };
  return {
    ok: false,
    message: `Atlas access could not be checked against Magnate, and this deployment holds no credential of its own${where}`,
  };
}
