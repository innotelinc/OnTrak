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

/** One product's answer, and the address it was actually asked at. */
export interface FleetProbe extends StatusResult {
  url: string;
}

/**
 * A product as a caller hands it over to be asked.
 *
 * Both callers already have one of these without building it: the dashboard passes the
 * tiles it is about to draw, and the check passes the catalogue, each entry carrying
 * the public address a browser would open and the path that address answers.
 */
export interface FleetEntry {
  key: string;
  /** The public address. An override, when one is set, replaces it — never the path. */
  url: string;
  health?: string | null;
}

/**
 * Probe the products given, one question each.
 *
 * THE ONE PLACE THIS QUESTION IS ASKED. There are two askers: the dashboard, per
 * request, for the tiles a person can see, and `npm run health:check`, which carries
 * the same answer out in an exit code for an operator. A second copy of the rule —
 * which statuses count as an answer, and which address to ask — is a second thing to
 * be wrong, and it goes wrong in the direction that costs most: the check calls the
 * family down while the dashboard two feet away draws every light green, or the
 * reverse, and neither is believed again.
 *
 * `internalUrlFor` is a function rather than a map because both callers resolve the
 * same variable (`ONTRAK_<KEY>_INTERNAL_URL`) from wherever they happen to run: the
 * page and the check read the process environment, and a test hands in an address of
 * its own. A product with no health path is *unknown*, never up (see `probeProduct`).
 */
export async function probeFleet(
  entries: readonly FleetEntry[],
  internalUrlFor: (key: string) => string | undefined = () => undefined,
): Promise<FleetProbe[]> {
  return Promise.all(
    entries.map(async (entry) => {
      const internal = internalUrlFor(entry.key);
      const base = (internal || entry.url).replace(/\/+$/, "");
      const answer = await probeProduct(entry, internal);
      // The address the question went to, which is the override when one was set —
      // the link the browser is given is never the internal one.
      return { ...answer, url: entry.health ? `${base}${entry.health}` : entry.url };
    }),
  );
}

/*
 * ── the account table, for administrators ──────────────────────────────────
 *
 * Two calls, both server-side, both with the deployment token — which Sync treats
 * as a service principal with the full capability set. The portal only reaches
 * them from the people page, and that page is drawn only for an ADMIN session, so
 * the token is never a browser credential.
 */

export interface SyncUserRow extends SyncUser {
  created_at?: string;
}

export async function listSyncUsers(): Promise<{ users: SyncUserRow[]; reason?: string }> {
  const config = portalConfig();
  if (!config.syncApiToken) {
    return { users: [], reason: "This deployment has no ONTRAK_SYNC_API_TOKEN, so the portal cannot read the account table." };
  }
  try {
    const response = await syncFetch("/api/users", {
      headers: { "X-API-Token": config.syncApiToken },
    });
    if (!response.ok) {
      return { users: [], reason: `OnTrak Sync refused the request (${response.status}).` };
    }
    const payload = (await response.json()) as { users?: SyncUserRow[] };
    return { users: payload.users ?? [] };
  } catch (cause) {
    return {
      users: [],
      reason: `OnTrak Sync could not be reached from the portal: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

/**
 * Change somebody's role, or switch their account off.
 *
 * Sync refuses to demote or deactivate the last active administrator, and that
 * refusal is passed through as its own sentence rather than a status code: it is
 * the one answer on this page an operator has to be able to read.
 */
export async function updateSyncUser(
  id: number,
  patch: { role?: Role; active?: boolean },
): Promise<{ ok: boolean; reason?: string }> {
  const config = portalConfig();
  if (!config.syncApiToken) {
    return { ok: false, reason: "This deployment has no ONTRAK_SYNC_API_TOKEN." };
  }
  try {
    const response = await syncFetch(`/api/users/${id}`, {
      method: "PUT",
      headers: { "X-API-Token": config.syncApiToken, "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (response.ok) return { ok: true };
    let detail = `OnTrak Sync refused the change (${response.status}).`;
    try {
      const payload = (await response.json()) as { detail?: unknown };
      if (typeof payload.detail === "string") detail = payload.detail;
      else if (payload.detail && typeof payload.detail === "object") {
        const problems = (payload.detail as { problems?: unknown }).problems;
        if (Array.isArray(problems) && problems.length) detail = problems.join("; ");
      }
    } catch {
      /* keep the status sentence */
    }
    return { ok: false, reason: detail };
  } catch (cause) {
    return {
      ok: false,
      reason: `OnTrak Sync could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

/** OnTrak Sync's own health, which the portal can read directly. */
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
