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
 * **The lab's address is delegated too, for the same reason.** `lab-rules.ts` already
 * reads `ONTRAK_LAB_ENABLED` and `ONTRAK_LAB_URL` for the student page's "start a real
 * machine" link, and its rule is that **both** are required: the lab is a peer
 * deployment on its own host, so a deployment that has not said it wants one and where
 * it is does not have one. Reading those variables a second time here would drift from
 * that rule, and it would drift in the direction that costs most — a link to
 * `lab.<base domain>` is not an address for a product nobody has deployed, and the
 * family's naming convention does not make it one. So the lab is `off` in such a
 * deployment: marked with the reason, linked nowhere. Only "running" is a question this
 * page does not ask — a link is offered whether or not a product is up.
 *
 * Pure — no fetch, no clock — so every state is cheap to assert and the page is only
 * presentation.
 */

import { LAB_ENABLED_ENV, LAB_URL_ENV, labConfigFromEnv } from "./lab-rules";
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
  /**
   * True when this deployment does not run the product at all.
   *
   * A different fact from a product that is merely not answering, and from one whose
   * address was *set and refused*: the lab is a peer deployment, so a deployment with no
   * lab is the normal case rather than a fault, and the panel says so instead of drawing
   * a red "no link".
   */
  off?: true;
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
 * Sentinel and the lab are deliberately absent: each has a reader that owns its
 * variables — `sentinelStatus` (which also knows `SENTINEL_ISSUER`) and
 * `labConfigFromEnv` (which also knows whether the deployment wants a lab at all).
 * Adding either here would be a second reader of the same variable, and the two would
 * drift.
 */
const EXPLICIT_URL_ENV: Record<Exclude<CapabilityId, "sentinel" | "lab">, string> = {
  training: "ONTRAK_TRAINING_BASE_URL",
  tix: "ONTRAK_TIX_BASE_URL",
  sync: "ONTRAK_SYNC_URL",
  genie: "ONTRAK_GENIE_URL",
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
    if (id === "lab") return labCapability(env);

    const explicit = withoutTrailingSlashes(read(env, EXPLICIT_URL_ENV[id]));
    if (explicit) return { id, url: explicit, named: true, note: null };
    return { id, url: familyUrl(id), named: false, note: null };
  });

  return resolved;
}

/**
 * The lab's row, from the reader that owns its variables.
 *
 * `off` is the deployment's normal state, not a fault: the lab runs on its own host and
 * has to be asked for. A value that *was* set and refused keeps the reason as its note,
 * the way Sentinel's does — the operator has something to fix there, and nothing to fix
 * when the lab simply is not wanted.
 */
function labCapability(env: Record<string, string | undefined>): Capability {
  const status = labConfigFromEnv(env);
  if (!status.enabled) {
    return {
      id: "lab",
      url: null,
      named: false,
      note: `${LAB_ENABLED_ENV} is not set, so this deployment does not run OnTrak Lab.`,
      off: true,
    };
  }
  if (!status.url) {
    return { id: "lab", url: null, named: false, note: status.issues.join(" ") || null };
  }
  // The reader returns the lab's origin, so the link loses nothing and cannot double a
  // segment — and it is `named` for the same reason an explicit URL is: an operator
  // stated where the lab is.
  return { id: "lab", url: status.url, named: true, note: null };
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
