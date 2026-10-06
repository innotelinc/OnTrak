/**
 * What this deployment is wired to — the three registrations, read once.
 *
 * The admin console is where an operator finds out that a deployment is *not*
 * configured the way they think it is, and there are three ways for that to be
 * true here: nobody can sign in through a provider, no LMS can launch a scenario,
 * or no directory can sync accounts. Each one is decided by its own rules module —
 * `ssoConfigFromEnv`, `ltiConfigFromEnv`, and the SCIM token — and this module exists
 * so the console does not have to know all three, and so the three are described
 * the same way.
 *
 * Two properties matter.
 *
 * **Nothing secret is in here.** The details are facts an operator already wrote in
 * `.env` — an issuer, a client id, a URL — and whether a *token* is set is reported
 * as the variable's name, never its value. An admin console that printed a shared
 * secret into a page somebody can screenshot would be a worse secret store than the
 * environment it read from.
 *
 * **The state is the route's state.** `incomplete` is not a softer word for broken:
 * it is the case where the rules module refuses the configuration outright, so
 * `/api/lti/*` and `/api/sso/*` answer `503` and the sign-in page shows no SSO
 * button. The console says the same thing the boot log says, about the same
 * deployment.
 *
 * Pure — no fetch, no database — so every state is cheap to assert, and the page is
 * only presentation.
 */

import { LTI_JWKS_PATH, LTI_LAUNCH_PATH, LTI_LOGIN_PATH, ltiConfigFromEnv } from "./lti-rules";
import { ssoConfigFromEnv } from "./oidc-rules";
import { SCIM_PATHS, SCIM_TOKEN_ENV } from "./scim-rules";

/** Off, working, or configured in a way the routes refuse. */
export type IntegrationState = "off" | "ready" | "incomplete";

export interface IntegrationDetail {
  /**
   * A stable name, which the console translates into a label. Kept as a token rather
   * than a sentence so the page owns the wording and this module owns the facts.
   */
  key: string;
  /** The configured value. Empty string when the deployment has not set it. */
  value: string;
}

export interface IntegrationStatus {
  id: "sso" | "lti" | "scim";
  state: IntegrationState;
  details: IntegrationDetail[];
  /** Why the routes refuse this one, when they do. Empty otherwise. */
  issues: string[];
}

/** The three, in the order an operator usually meets them. */
export function integrationStatuses(env: Record<string, string | undefined> = process.env): IntegrationStatus[] {
  return [ssoStatus(env), ltiStatus(env), scimStatus(env)];
}

function ssoStatus(env: Record<string, string | undefined>): IntegrationStatus {
  const { enabled, config, issues } = ssoConfigFromEnv(env);
  if (!enabled) return { id: "sso", state: "off", details: [], issues: [] };
  // Half-wired: the sign-in page publishes no button, and the reason is worth
  // showing precisely because nothing else on the page would give it away.
  if (!config) return { id: "sso", state: "incomplete", details: [], issues };

  return {
    id: "sso",
    state: "ready",
    issues: [],
    details: [
      { key: "issuer", value: config.issuer },
      { key: "clientId", value: config.clientId },
      // Empty means every domain the provider will authenticate, which is a fact an
      // administrator should be able to read off the page rather than infer.
      { key: "allowedDomains", value: config.allowedDomains.join(", ") },
    ],
  };
}

function ltiStatus(env: Record<string, string | undefined>): IntegrationStatus {
  const { enabled, config, issues } = ltiConfigFromEnv(env);
  if (!enabled) return { id: "lti", state: "off", details: [], issues: [] };
  if (!config) return { id: "lti", state: "incomplete", details: [], issues };

  return {
    id: "lti",
    state: "ready",
    issues: [],
    details: [
      { key: "issuer", value: config.issuer },
      { key: "clientId", value: config.clientId },
      { key: "launchPath", value: LTI_LAUNCH_PATH },
      { key: "loginPath", value: LTI_LOGIN_PATH },
      // The URL an LMS registers so it can verify the assertions this tool signs —
      // the alternative to being handed a copy of the public key.
      { key: "keySetPath", value: LTI_JWKS_PATH },
      // Both empty means launch-only: scenarios open, grades stay here.
      { key: "passback", value: config.tokenEndpoint ?? "" },
      { key: "keyId", value: config.keyId ?? "" },
    ],
  };
}

function scimStatus(env: Record<string, string | undefined>): IntegrationStatus {
  // The endpoints exist either way — `ServiceProviderConfig` answers without a token
  // — so the paths are facts about the deployment, and only the token decides whether
  // a connector can do anything with them.
  const details: IntegrationDetail[] = [
    { key: "usersPath", value: SCIM_PATHS.users },
    { key: "groupsPath", value: SCIM_PATHS.groups },
    { key: "tokenEnv", value: SCIM_TOKEN_ENV },
  ];
  const token = (env[SCIM_TOKEN_ENV] ?? "").trim();
  return { id: "scim", state: token ? "ready" : "off", details, issues: [] };
}
