/**
 * The family's capabilities, as one list — the data behind the control room's
 * capabilities panel.
 *
 * OnTrak is a family of separately-deployable products, and the portal is the front
 * door that routes a role to the ones it belongs in. This module is the training
 * app's smaller version of the same idea: a single list of what this deployment can
 * reach, so the control room does not grow a hand-written tile per product and then
 * forget one.
 *
 * Three things are worth stating out loud.
 *
 * **It mirrors the portal's own catalogue.** The product keys, the subdomain labels
 * and the role audiences are the ones `ontrak-portal/src/lib/portal-rules.ts`
 * already defines, because two products disagreeing about what "Sentinel" is called
 * or where it lives is exactly the drift a family catalogue exists to prevent.
 *
 * **A capability is `named` or it is reached by the family's names.** A deployment
 * that has set an explicit URL for a product has *named* it, and the panel can say
 * so; one that has not is reached at `<host>.<base domain>`, which is where the
 * portal would send somebody anyway. An explicit URL never carries a trailing slash
 * into a link, and a base domain is read the way the portal reads it (`ONTRAK_PORTAL_BASE_DOMAIN`,
 * default the Network's real name, scheme following `ONTRAK_PORTAL_SECURE`).
 *
 * **Sentinel is delegated, not re-derived.** It has its own reader
 * (`sentinel-status.ts`) with a richer state — a console URL can be *set and
 * refused* — so the Sentinel entry is built from `sentinelStatus` and the rest of
 * this file never looks at its variables. The lab is the one product here that is not
 * built in this repository: it is OnTrak-dev, the hands-on platform that runs real
 * Linux VMs and scenario instances, and the portal catalogue carries it as the `lab`
 * entry — the same host label, and probed at `/healthz`, the path a Python peer
 * actually serves.
 *
 * Pure — no fetch, no clock — so every state is cheap to assert and the page is only
 * presentation.
 */

import { SENTINEL_CONTROL_CENTER_PATH, sentinelStatus } from "./sentinel-status";

export type CapabilityId = "training" | "tix" | "sentinel" | "sync" | "genie" | "lab";

export interface Capability {
  id: CapabilityId;
  /** Absolute browser URL, or null when this deployment cannot reach it. */
  url: string | null;
  /** True when the deployment named it explicitly rather than relying on the family's names. */
  named: boolean;
  /** Why there is no URL, when there is none. null otherwise. */
  note: string | null;
}

/** The Network's real name, so an unconfigured deployment still produces a link that resolves. */
const DEFAULT_BASE_DOMAIN = "ontrak.innotel.us";

/** The subdomain label for each product — the portal's own `host` field. */
const HOSTS: Record<CapabilityId, string> = {
  training: "its",
  tix: "tix",
  sentinel: "sentinel",
  sync: "sync",
  genie: "genie",
  lab: "lab",
};

/**
 * The variable that names a product's own address, per id.
 *
 * Sentinel is deliberately absent: its URL is read through `sentinelStatus`, which
 * also knows `SENTINEL_ISSUER` and which refuses a value it cannot open. Adding it
 * here would be a second reader of the same variable, and the two would drift.
 */
const EXPLICIT_URL_ENV: Record<Exclude<CapabilityId, "sentinel">, string> = {
  training: "ONTRAK_TRAINING_BASE_URL",
  tix: "ONTRAK_TIX_BASE_URL",
  sync: "ONTRAK_SYNC_URL",
  genie: "ONTRAK_GENIE_URL",
  lab: "ONTRAK_LAB_URL",
};

/** The order they are listed in: this app first, then the products, then the lab. */
const ORDER: readonly CapabilityId[] = ["training", "tix", "sentinel", "sync", "genie", "lab"];

/**
 * One variable, unquoted.
 *
 * `.env` has three readers that disagree: compose unquotes, `docker run --env-file`
 * does not, and a shell that sources the file does. Stripping a fully-quoted value
 * here is what makes a URL behave the same for all three — the same convention
 * `ontrak-portal/src/lib/config.ts` uses.
 */
function read(env: Record<string, string | undefined>, name: string): string {
  const raw = (env[name] ?? "").trim();
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).trim();
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).trim();
  return raw;
}

/** A URL never carries a trailing slash into a link. */
function withoutTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/** `ontrak.innotel.us.` is the same name as `ontrak.innotel.us`. */
function withoutTrailingDots(value: string): string {
  return value.replace(/\.+$/, "");
}

export function capabilities(env: Record<string, string | undefined> = process.env): Capability[] {
  const baseDomain = withoutTrailingDots(read(env, "ONTRAK_PORTAL_BASE_DOMAIN") || DEFAULT_BASE_DOMAIN);
  // The scheme follows the deployment rather than being assumed: a family served over
  // plain HTTP on a LAN address must link to plain HTTP, or every tile is a dead link
  // with a certificate error.
  const scheme = read(env, "ONTRAK_PORTAL_SECURE").toLowerCase() === "false" ? "http" : "https";

  const familyUrl = (id: CapabilityId): string => `${scheme}://${HOSTS[id]}.${baseDomain}`;

  const resolved = ORDER.map<Capability>((id) => {
    if (id === "sentinel") return sentinelCapability(env, scheme, baseDomain);

    const explicit = withoutTrailingSlashes(read(env, EXPLICIT_URL_ENV[id]));
    if (explicit) return { id, url: explicit, named: true, note: null };
    return { id, url: familyUrl(id), named: false, note: null };
  });

  return resolved;
}

/**
 * Sentinel's row, from the reader that owns its variables.
 *
 * `ready` uses the control center URL the reader computed; `incomplete` is the case
 * worth showing — a value was set and refused, so there is no link and the reason is
 * carried as the note; `off` falls back to the family's name like every other entry.
 */
function sentinelCapability(
  env: Record<string, string | undefined>,
  scheme: string,
  baseDomain: string,
): Capability {
  const status = sentinelStatus(env);
  if (status.state === "ready" && status.controlCenterUrl) {
    return { id: "sentinel", url: status.controlCenterUrl, named: true, note: null };
  }
  if (status.state === "incomplete") {
    return { id: "sentinel", url: null, named: false, note: status.issues.join(" ") || null };
  }
  return {
    id: "sentinel",
    url: `${scheme}://${HOSTS.sentinel}.${baseDomain}${SENTINEL_CONTROL_CENTER_PATH}`,
    named: false,
    note: null,
  };
}
