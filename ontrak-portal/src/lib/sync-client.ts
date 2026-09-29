/**
 * The portal's link to OnTrak Sync.
 *
 * The portal deliberately has no account table of its own. Cerulean (Authentik)
 * is the directory, and OnTrak Sync is where the family keeps a *local* account
 * when the directory is not the way in — a sysadmin on a LAN with no route to the
 * provider, or the first deployment before Cerulean has been wired up at all.
 * So a password sign-in here is delegated to Sync's `/api/auth/login`, and the
 * role that comes back is Sync's decision, made from the same role table the rest
 * of the family uses.
 *
 * This is the integration the family was designed around: one identity layer, and
 * every product consuming it rather than re-implementing it.
 */

import { asRole, type Role } from "./portal-rules";
import { portalConfig } from "./config";

export interface SyncUser {
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: string;
  active: boolean;
}

export interface SyncSignIn {
  ok: boolean;
  user?: SyncUser;
  /** Seconds to wait, from the lockout, when the refusal was a throttle. */
  retryAfter?: number;
  reason?: string;
}

const TIMEOUT_MS = 8_000;

async function syncFetch(path: string, init?: RequestInit): Promise<Response> {
  const config = portalConfig();
  return fetch(`${config.syncApiUrl}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
  });
}

/**
 * Sign a person in against OnTrak Sync's account table.
 *
 * The refusal reason is passed through rather than replaced: Sync answers a wrong
 * password and an unknown account with the same sentence *on purpose*, so the
 * portal must not "helpfully" distinguish them either.
 */
export async function signInWithSync(username: string, password: string): Promise<SyncSignIn> {
  let response: Response;
  try {
    response = await syncFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    return {
      ok: false,
      reason: "OnTrak Sync could not be reached, so its account table is not "
        + "available. Sign in with Cerulean if it is configured.",
    };
  }

  if (response.status === 401) {
    let detail = "Invalid username or password.";
    try {
      const payload = (await response.json()) as { detail?: unknown };
      if (typeof payload.detail === "string") detail = payload.detail;
    } catch {
      // Keep the generic sentence; the body is optional.
    }
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    return { ok: false, reason: detail, retryAfter: Number.isFinite(retryAfter) ? retryAfter : 0 };
  }

  if (!response.ok) {
    return { ok: false, reason: `OnTrak Sync refused the sign-in (${response.status}).` };
  }

  try {
    const payload = (await response.json()) as { user?: SyncUser };
    if (!payload.user) return { ok: false, reason: "OnTrak Sync returned no account." };
    return { ok: true, user: payload.user };
  } catch {
    return { ok: false, reason: "OnTrak Sync returned a response that is not readable." };
  }
}

export function roleOfSyncUser(user: SyncUser): Role {
  return asRole(user.role);
}

/**
 * A product's liveness, for the tile's corner.
 *
 * THREE STATES, NOT TWO. `up` means something answered; `down` means the request
 * failed; `unknown` means this deployment has nothing to ask. A tile that reports
 * `up` because it could not check is the failure mode this whole family exists to
 * remove, so "not checked" is a first-class answer here too.
 */
export type Reachability = "up" | "down" | "unknown";

export interface StatusResult {
  key: string;
  reachability: Reachability;
  detail: string;
}

/**
 * Probe one product.
 *
 * `internalUrl` exists because the public name for a product may not be reachable
 * from inside the container that is asking (hairpin NAT, or a certificate the
 * container does not trust). When a deployment sets one, the probe uses it and the
 * *link* still uses the public name — probing an internal address must never
 * change what a browser is told to open.
 */
export async function probeProduct(entry: {
  key: string;
  url: string;
  /** The path to ask, or nullish when a deployment has none to offer. */
  health?: string | null;
}, internalUrl?: string): Promise<StatusResult> {
  if (!entry.health) {
    return { key: entry.key, reachability: "unknown", detail: "no health endpoint to ask" };
  }
  const base = (internalUrl || entry.url).replace(/\/+$/, "");
  const target = `${base}${entry.health}`;
  try {
    const response = await fetch(target, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(3_500),
    });
    // Any answer at all — including a redirect to a sign-in page — means the
    // product is serving. The point of the probe is "is it there", not "am I
    // allowed in", and a 401 is a perfectly healthy product.
    const healthy = response.ok || response.status === 401 || response.status === 403 ||
      (response.status >= 300 && response.status < 400);
    return {
      key: entry.key,
      reachability: healthy ? "up" : "down",
      detail: `${response.status} ${response.statusText}`.trim(),
    };
  } catch (cause) {
    return {
      key: entry.key,
      reachability: "down",
      detail: cause instanceof Error ? cause.message : "no response",
    };
  }
}

/** The estate's own health, which the portal can read directly. */
export async function syncHealth(): Promise<{
  status: string;
  scheduler: boolean;
  hosts_configured: number;
} | null> {
  try {
    const response = await syncFetch("/api/health");
    if (!response.ok) return null;
    return (await response.json()) as {
      status: string; scheduler: boolean; hosts_configured: number;
    };
  } catch {
    return null;
  }
}
