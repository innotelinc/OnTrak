/**
 * What this deployment knows about OnTrak Sentinel — the family's identity provider and
 * its intrusion detection & prevention platform.
 *
 * The control room's own three integrations (`integration-status.ts`) are the things *this*
 * app is wired to. Sentinel is different in kind: it is a product beside this one, with its
 * own console on its own origin, and the most this app can honestly report is whether it has
 * been told where that console is. So it is its own module with its own state rather than a
 * fourth entry in `integrationStatuses` — a tile that says "off" when the URL is unset, and a
 * link that is drawn only when there is somewhere to go.
 *
 * Two properties, borrowed from the integrations panel on purpose. **Nothing secret is in
 * here**: a console URL and an issuer are facts an operator wrote in `.env`, and no token or
 * password is read at all. And **the state is the link's state** — `ready` means there is an
 * absolute URL to open, `off` means there is not, and `incomplete` means one was set and
 * refused, which is the case the tile exists to make visible rather than to paper over.
 */

export type SentinelState = "off" | "ready" | "incomplete";

/** The console's base URL, when a deployment names it explicitly. */
export const SENTINEL_CONSOLE_URL_ENV = "SENTINEL_CONSOLE_URL";
/** The IdP issuer, which is also the console's origin — the fallback for the base URL. */
export const SENTINEL_ISSUER_ENV = "SENTINEL_ISSUER";
/** The page this tile exists to reach: Sentinel's IDS/IPS control center. */
export const SENTINEL_CONTROL_CENTER_PATH = "/console/control-center";

/**
 * One row of the tile. A stable token rather than a sentence, so the page owns the wording
 * and this module owns the facts — the same split the integrations panel uses.
 */
export interface SentinelDetail {
  key: string;
  value: string;
}

export interface SentinelStatus {
  state: SentinelState;
  /** The URL to open, or `null` when the deployment has not named a console. */
  controlCenterUrl: string | null;
  /** The provider's issuer, when set. `null` when it is not. */
  issuer: string | null;
  details: SentinelDetail[];
  /** Why a configured value was refused. Empty otherwise. */
  issues: string[];
}

/**
 * The base URL for the console: an explicit one, or failing that the issuer's origin.
 *
 * One variable would be enough in most deployments — the console is served from the same
 * origin as the IdP — but a deployment may put its console behind a different host, so an
 * explicit `SENTINEL_CONSOLE_URL` wins.
 */
function consoleBase(env: Record<string, string | undefined>): string {
  return (env[SENTINEL_CONSOLE_URL_ENV] ?? env[SENTINEL_ISSUER_ENV] ?? "").trim();
}

export function sentinelStatus(env: Record<string, string | undefined> = process.env): SentinelStatus {
  const base = consoleBase(env);
  const issuer = (env[SENTINEL_ISSUER_ENV] ?? "").trim();

  if (!base) {
    return { state: "off", controlCenterUrl: null, issuer: null, details: [], issues: [] };
  }

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return {
      state: "incomplete",
      controlCenterUrl: null,
      issuer: issuer || null,
      details: [],
      issues: [`${base} is not an absolute URL.`],
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      state: "incomplete",
      controlCenterUrl: null,
      issuer: issuer || null,
      details: [],
      issues: [`${base} is not an http(s) URL.`],
    };
  }

  // The origin rather than the raw value: a console base that carried a path or a trailing
  // slash would otherwise produce a doubled segment, and the control center has one home.
  const controlCenterUrl = `${url.origin}${SENTINEL_CONTROL_CENTER_PATH}`;
  return {
    state: "ready",
    controlCenterUrl,
    issuer: issuer || null,
    details: [
      { key: "controlCenter", value: controlCenterUrl },
      { key: "issuer", value: issuer },
    ],
    issues: [],
  };
}
