/**
 * LTI 1.3 rules: the pure half of launching this product from an LMS.
 *
 * Single sign-on answers "who is this person?". LTI answers a harder set of
 * questions, because the browser arrives at *our* URL from somebody else's
 * product, carrying an assertion we did not ask for in a flow we did not start:
 *
 *  * **Which platform is this?** A launch is trusted only when it comes from the
 *    issuer this deployment registered, for the client id it registered, in the
 *    deployment the platform named. Everything here is keyed on that.
 *  * **Is this launch ours?** LTI 1.3 is OIDC underneath: we begin with a
 *    third-party-initiated login, send a `state` and a `nonce` that travel in a
 *    signed cookie, and refuse a launch whose assertion does not carry them back.
 *  * **What does the launch mean *here*?** The platform sends an LIS role, a
 *    course context and a resource link; the product has a role, a cohort and an
 *    assignment. `ltiRoleOf` is the whole of that translation, and it is a
 *    mapping, never a guess.
 *  * **Where does the grade go?** The Assignment & Grade Services claim carries
 *    the line item the score belongs on, and the scopes that say whether we may
 *    write it. A platform that did not grant the score scope is told so rather
 *    than being silently ignored.
 *
 * Pure on purpose — no fetch, no `jose`, no cookies, no database — so every
 * refusal is testable without an LMS, and so the live routes are only wiring.
 * The cookie *names* live here for the same reason they do in `oidc-rules.ts`: a
 * test that looks for a Set-Cookie header cannot import a `server-only` module to
 * find out what to look for.
 */

import { isSsoRole, type SsoRole } from "./oidc-rules";

/* -------------------------------------------------------------------------- */
/*  The specification's own vocabulary                                        */
/* -------------------------------------------------------------------------- */

export const LTI_VERSION = "1.3.0";

/** Claim names, spelled once. A typo in a claim name is a silent refusal. */
export const LTI_CLAIM = {
  messageType: "https://purl.imsglobal.org/spec/lti/claim/message_type",
  version: "https://purl.imsglobal.org/spec/lti/claim/version",
  deploymentId: "https://purl.imsglobal.org/spec/lti/claim/deployment_id",
  targetLinkUri: "https://purl.imsglobal.org/spec/lti/claim/target_link_uri",
  resourceLink: "https://purl.imsglobal.org/spec/lti/claim/resource_link",
  context: "https://purl.imsglobal.org/spec/lti/claim/context",
  roles: "https://purl.imsglobal.org/spec/lti/claim/roles",
  custom: "https://purl.imsglobal.org/spec/lti/claim/custom",
  lis: "https://purl.imsglobal.org/spec/lti/claim/lis",
  agsEndpoint: "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint",
} as const;

export const LTI_MESSAGE_TYPES = {
  resourceLink: "LtiResourceLinkRequest",
  deepLinking: "LtiDeepLinkingRequest",
} as const;

/** The one AGS scope this product needs: writing a score. */
export const LTI_AGS_SCORE_SCOPE = "https://purl.imsglobal.org/spec/lti-ags/scope/score";

export const LTI_ROLE_PREFIX = "http://purl.imsglobal.org/vocab/lis/v2/";

/** The custom claim names a deployment can set on a resource link, if it wants to. */
export const LTI_CUSTOM_ASSIGNMENT = "ontrak_assignment";
export const LTI_CUSTOM_COHORT = "ontrak_cohort";

export const LTI_LOGIN_PATH = "/api/lti/login";
export const LTI_LAUNCH_PATH = "/api/lti/launch";

/** The round trip's state, and the launch context an attempt inherits. */
export const LTI_STATE_COOKIE = "ontrak_training_lti";
export const LTI_LAUNCH_COOKIE = "ontrak_training_lti_launch";
export const LTI_STATE_TTL_SECONDS = 600;
/**
 * How long a launch's grading context waits for the learner to actually start
 * something. Longer than the handshake because a person reads the assignment
 * first; short enough that yesterday's launch cannot attach a course that the
 * learner has since left.
 */
export const LTI_LAUNCH_TTL_SECONDS = 3600;

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

export interface LtiConfig {
  issuer: string;
  clientId: string;
  /** Deployments of this registration the platform may name. Empty means any. */
  deploymentIds: string[];
  authorizationEndpoint: string;
  jwksUri: string;
  /** Where a score's access token is minted. Absent means no grade passback. */
  tokenEndpoint: string | null;
  /** PEM private key for the client assertion, and the key id the platform knows. */
  privateKey: string | null;
  keyId: string | null;
  defaultRole: SsoRole;
}

export interface LtiConfigResult {
  enabled: boolean;
  config: LtiConfig | null;
  issues: string[];
}

export const LTI_ENV = {
  issuer: "ONTRAK_LTI_ISSUER",
  clientId: "ONTRAK_LTI_CLIENT_ID",
  deploymentIds: "ONTRAK_LTI_DEPLOYMENT_IDS",
  authorizationEndpoint: "ONTRAK_LTI_AUTHORIZATION_ENDPOINT",
  jwksUri: "ONTRAK_LTI_JWKS_URI",
  tokenEndpoint: "ONTRAK_LTI_TOKEN_ENDPOINT",
  privateKey: "ONTRAK_LTI_PRIVATE_KEY",
  keyId: "ONTRAK_LTI_KEY_ID",
  defaultRole: "ONTRAK_LTI_DEFAULT_ROLE",
} as const;

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function normalizeIssuer(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * Read the deployment's LTI registration.
 *
 * **Unset means off**, exactly as single sign-on is: an installation with no
 * platform keeps its ordinary sign-in, and `/api/lti/*` answers 503 rather than
 * failing halfway. **Half-set means an issue**, because a registration missing
 * its JWKS URI is a button in somebody's LMS that can never complete, and the
 * person clicking it has no way to tell that from this product being broken.
 */
export function ltiConfigFromEnv(env: Record<string, string | undefined> = process.env): LtiConfigResult {
  const issuer = (env[LTI_ENV.issuer] ?? "").trim();
  const clientId = (env[LTI_ENV.clientId] ?? "").trim();
  if (!issuer && !clientId) return { enabled: false, config: null, issues: [] };

  const refuse = (issues: string[]): LtiConfigResult => ({ enabled: true, config: null, issues });
  const issues: string[] = [];
  if (!issuer) issues.push(`${LTI_ENV.issuer} is not set.`);
  if (!clientId) issues.push(`${LTI_ENV.clientId} is not set.`);
  if (issuer && !isHttpUrl(issuer)) issues.push(`${LTI_ENV.issuer} must be an absolute http(s) URL.`);

  // The platform tells us these; we do not discover them, because LTI 1.3 has no
  // discovery document — the registration *is* the discovery.
  const authorizationEndpoint = (env[LTI_ENV.authorizationEndpoint] ?? "").trim();
  const jwksUri = (env[LTI_ENV.jwksUri] ?? "").trim();
  if (issuer && !isHttpUrl(authorizationEndpoint)) {
    issues.push(`${LTI_ENV.authorizationEndpoint} must be an absolute http(s) URL.`);
  }
  if (issuer && !isHttpUrl(jwksUri)) issues.push(`${LTI_ENV.jwksUri} must be an absolute http(s) URL.`);

  const defaultRole = (env[LTI_ENV.defaultRole] ?? "STUDENT").trim().toUpperCase();
  if (!isSsoRole(defaultRole)) {
    issues.push(`${LTI_ENV.defaultRole} must be ADMIN, INSTRUCTOR or STUDENT.`);
  }

  const tokenEndpoint = (env[LTI_ENV.tokenEndpoint] ?? "").trim();
  if (tokenEndpoint && !isHttpUrl(tokenEndpoint)) {
    issues.push(`${LTI_ENV.tokenEndpoint} must be an absolute http(s) URL.`);
  }
  const privateKey = (env[LTI_ENV.privateKey] ?? "").trim();
  const keyId = (env[LTI_ENV.keyId] ?? "").trim();
  if (privateKey && !keyId) issues.push(`${LTI_ENV.keyId} is required when a private key is set.`);
  if (tokenEndpoint && !privateKey) {
    // Not an issue: reading the claim and launching work without it. It is worth
    // saying out loud, though, because the failure is otherwise a score that is
    // never written and never missed.
    issues.push(
      `${LTI_ENV.tokenEndpoint} is set without ${LTI_ENV.privateKey}, so a launch cannot pass a grade back.`,
    );
  }

  if (issues.length > 0) return refuse(issues);

  return {
    enabled: true,
    issues: [],
    config: {
      issuer: normalizeIssuer(issuer),
      clientId,
      deploymentIds: splitList(env[LTI_ENV.deploymentIds] ?? ""),
      authorizationEndpoint,
      jwksUri,
      tokenEndpoint: tokenEndpoint || null,
      privateKey: privateKey || null,
      keyId: keyId || null,
      defaultRole: defaultRole as SsoRole,
    },
  };
}

/** The active registration, or `null` when LTI is off or broken. */
export function activeLtiConfig(env: Record<string, string | undefined> = process.env): LtiConfig | null {
  return ltiConfigFromEnv(env).config;
}

/** Why LTI is configured but unusable, for a boot log or an operator page. */
export function ltiConfigIssues(env: Record<string, string | undefined> = process.env): string[] {
  const result = ltiConfigFromEnv(env);
  return result.enabled && result.config === null ? result.issues : [];
}

/**
 * The one line a boot log should print when a platform is registered but unusable.
 *
 * `ltiConfigIssues` already knows every way a registration can be half-wired — a
 * missing endpoint, a private key with no key id, a token endpoint with nothing to
 * sign with — and the routes answer `503` with the first of them. None of that is
 * visible anywhere until somebody clicks the platform's link, though, and by then
 * the person seeing it is a learner with no way to tell a broken deployment from a
 * broken product. So the deployment says it out loud at startup instead.
 *
 * Returns `null` when LTI is off — the ordinary case, and not a mistake — or when
 * the registration is complete. Wording a whole sentence rather than a code is
 * deliberate: an operator reads this in a container log, not a stack trace.
 */
export function ltiConfigWarning(env: Record<string, string | undefined> = process.env): string | null {
  const issues = ltiConfigIssues(env);
  if (issues.length === 0) return null;
  return `[lti] This deployment has a learning platform configured, but it cannot be used, so /api/lti/* answers 503: ${issues.join(" ")}`;
}

/** Split a comma- or newline-separated value into trimmed, non-empty entries. */
export function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/*  The launch's origin                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The single redirect URI this deployment is registered under.
 *
 * It is the tool's *launch* URL rather than its sign-in callback, because that is
 * where an LMS sends `id_token`, and it is matched exactly by the platform.
 */
export function ltiRedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${LTI_LAUNCH_PATH}`;
}

/* -------------------------------------------------------------------------- */
/*  Step one: the platform's login initiation                                  */
/* -------------------------------------------------------------------------- */

export interface LtiLoginRequest {
  issuer: string;
  loginHint: string;
  clientId: string | null;
  deploymentId: string | null;
  targetLinkUri: string | null;
  messageHint: string | null;
}

export type LtiLoginResult = { ok: true; request: LtiLoginRequest } | { ok: false; reason: string };

/**
 * Read a third-party-initiated login.
 *
 * `iss` and `login_hint` are required by the specification, and `iss` is checked
 * against the registration here rather than later: a login naming another issuer
 * is not a launch we are about to refuse, it is a request from somebody else's
 * platform that should never have reached us.
 */
export function readLtiLogin(params: URLSearchParams, config: LtiConfig): LtiLoginResult {
  const issuer = (params.get("iss") ?? "").trim();
  if (!issuer) return { ok: false, reason: "The launch carried no platform identifier." };
  if (normalizeIssuer(issuer) !== config.issuer) {
    return { ok: false, reason: "That platform is not the one this deployment registered with." };
  }

  const loginHint = (params.get("login_hint") ?? "").trim();
  if (!loginHint) return { ok: false, reason: "The launch carried nobody to sign in." };

  const clientId = (params.get("client_id") ?? "").trim();
  if (clientId && clientId !== config.clientId) {
    return { ok: false, reason: "That platform asked for a client this deployment does not have." };
  }

  const deploymentId = (params.get("deployment_id") ?? "").trim();
  if (deploymentId && !deploymentAllowed(config, deploymentId)) {
    return { ok: false, reason: `Deployment "${deploymentId}" is not registered here.` };
  }

  return {
    ok: true,
    request: {
      issuer,
      loginHint,
      clientId: clientId || null,
      deploymentId: deploymentId || null,
      targetLinkUri: (params.get("target_link_uri") ?? "").trim() || null,
      messageHint: (params.get("lti_message_hint") ?? "").trim() || null,
    },
  };
}

function deploymentAllowed(config: LtiConfig, deploymentId: string): boolean {
  return config.deploymentIds.length === 0 || config.deploymentIds.includes(deploymentId);
}

export interface LtiLoginRedirect {
  loginHint: string;
  targetLinkUri: string;
  messageHint: string | null;
  state: string;
  nonce: string;
  redirectUri: string;
}

/**
 * The authorization request, as LTI 1.3 states it.
 *
 * `response_mode=form_post` is not a preference: the assertion arrives as a POST
 * to our launch URL, and a provider that answered with a fragment would put an
 * ID token in a URL. `prompt=none` is what makes it a launch rather than an
 * interactive sign-in — the platform has already authenticated the person, and a
 * prompt would be this product asking twice.
 */
export function buildLtiLoginUrl(config: LtiConfig, redirect: LtiLoginRedirect): string {
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set("response_type", "id_token");
  url.searchParams.set("response_mode", "form_post");
  url.searchParams.set("scope", "openid");
  url.searchParams.set("prompt", "none");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirect.redirectUri);
  url.searchParams.set("state", redirect.state);
  url.searchParams.set("nonce", redirect.nonce);
  url.searchParams.set("login_hint", redirect.loginHint);
  url.searchParams.set("target_link_uri", redirect.targetLinkUri);
  if (redirect.messageHint) url.searchParams.set("lti_message_hint", redirect.messageHint);
  return url.toString();
}

/* -------------------------------------------------------------------------- */
/*  Step three: what the assertion means                                       */
/* -------------------------------------------------------------------------- */

export interface LtiResourceLink {
  id: string;
  title: string | null;
  description: string | null;
}

export interface LtiContext {
  id: string | null;
  title: string | null;
  label: string | null;
}

export interface LtiLaunch {
  issuer: string;
  subject: string;
  deploymentId: string;
  version: string | null;
  name: string;
  email: string;
  roles: string[];
  localRole: SsoRole;
  /** True when an LIS role chose the local role, rather than the default. */
  roleMapped: boolean;
  resourceLink: LtiResourceLink;
  context: LtiContext;
  custom: Record<string, string>;
  /** The AGS line item a score belongs on, when the platform sent one. */
  lineItem: string | null;
  agsScopes: string[];
  /** What the platform believes it is launching, so an operator can see it. */
  targetLinkUri: string | null;
}

export type LtiLaunchResult = { ok: true; launch: LtiLaunch } | { ok: false; reason: string };

export interface ExpectedLaunch {
  issuer: string;
  clientId: string;
  nonce: string;
  deploymentIds?: string[];
  /** What an LIS role this deployment does not recognise becomes. */
  defaultRole?: SsoRole;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value === "string") return [value];
  return [];
}

/** `aud` is a string *or* a list, and a platform that sends a list is compliant. */
function audienceIncludes(aud: unknown, clientId: string): boolean {
  return asStringArray(aud).includes(clientId);
}

/**
 * Turn a verified launch assertion into what this product understands.
 *
 * The signature has been checked by the client against the platform's published
 * keys; everything only the caller can check is checked here. Every refusal is a
 * sentence an operator can act on, because the alternative — a generic "invalid
 * launch" — leaves them comparing two JSON documents by eye.
 */
export function extractLaunchClaims(
  payload: Record<string, unknown>,
  expected: ExpectedLaunch,
): LtiLaunchResult {
  if (normalizeIssuer(asString(payload.iss)) !== normalizeIssuer(expected.issuer)) {
    return { ok: false, reason: "The launch assertion was not issued by this deployment's registered platform." };
  }
  if (!audienceIncludes(payload.aud, expected.clientId)) {
    return { ok: false, reason: "The launch assertion was addressed to a different client." };
  }
  // `azp` is the client that *asked*; when it is present it must be us, or a token
  // minted for one audience is being replayed at another.
  const azp = asString(payload.azp);
  if (azp && azp !== expected.clientId) {
    return { ok: false, reason: "The launch assertion was authorized for a different client." };
  }
  if (payload.nonce !== expected.nonce) {
    return { ok: false, reason: "The launch did not match the request this deployment started." };
  }

  const deploymentId = asString(payload[LTI_CLAIM.deploymentId]);
  if (!deploymentId) {
    return { ok: false, reason: "The launch named no deployment." };
  }
  if (expected.deploymentIds && expected.deploymentIds.length > 0 && !expected.deploymentIds.includes(deploymentId)) {
    return { ok: false, reason: `Deployment "${deploymentId}" is not registered here.` };
  }

  const version = asString(payload[LTI_CLAIM.version]);
  if (version && version !== LTI_VERSION) {
    return { ok: false, reason: `Only LTI ${LTI_VERSION} launches are supported, and this one is ${version}.` };
  }

  const messageType = asString(payload[LTI_CLAIM.messageType]);
  if (messageType === LTI_MESSAGE_TYPES.deepLinking) {
    return { ok: false, reason: "Deep linking is not something this deployment offers." };
  }
  if (messageType !== LTI_MESSAGE_TYPES.resourceLink) {
    return { ok: false, reason: `This deployment can only launch a resource link, and the platform sent "${messageType || "no message type"}".` };
  }

  const subject = asString(payload.sub);
  if (!subject) return { ok: false, reason: "The launch named nobody." };

  // An email is required, and not for convenience: the account this launch lands
  // on is found by provider subject and, for a first launch, created — and a
  // product that invented an address for somebody would be handing them an
  // identity nobody can look up afterwards.
  const email = asString(payload.email).toLowerCase();
  if (!email.includes("@")) {
    return { ok: false, reason: "The platform did not send an email address for this person, so they cannot be matched to an account here." };
  }

  const resourceLinkRaw = payload[LTI_CLAIM.resourceLink];
  const resourceLink = typeof resourceLinkRaw === "object" && resourceLinkRaw !== null
    ? (resourceLinkRaw as Record<string, unknown>)
    : {};
  const resourceLinkId = asString(resourceLink.id);
  if (!resourceLinkId) {
    return { ok: false, reason: "The launch named no resource link, so there is nothing to open." };
  }

  const contextRaw = payload[LTI_CLAIM.context];
  const context = typeof contextRaw === "object" && contextRaw !== null
    ? (contextRaw as Record<string, unknown>)
    : {};

  const endpointRaw = payload[LTI_CLAIM.agsEndpoint];
  const endpoint = typeof endpointRaw === "object" && endpointRaw !== null
    ? (endpointRaw as Record<string, unknown>)
    : {};

  const roles = asStringArray(payload[LTI_CLAIM.roles]);
  const mapped = ltiRoleOf(roles, expected.defaultRole);
  const name = asString(payload.name) || asString((payload[LTI_CLAIM.lis] as Record<string, unknown> | undefined)?.person_sourcedid) || email;

  const customRaw = payload[LTI_CLAIM.custom];
  const custom: Record<string, string> = {};
  if (typeof customRaw === "object" && customRaw !== null) {
    for (const [key, value] of Object.entries(customRaw as Record<string, unknown>)) {
      const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
      if (text) custom[key] = text;
    }
  }

  return {
    ok: true,
    launch: {
      issuer: expected.issuer,
      subject,
      deploymentId,
      version: version || null,
      name,
      email,
      roles,
      localRole: mapped.role,
      roleMapped: mapped.mapped,
      resourceLink: {
        id: resourceLinkId,
        title: asString(resourceLink.title) || null,
        description: asString(resourceLink.description) || null,
      },
      context: {
        id: asString(context.id) || null,
        title: asString(context.title) || null,
        label: asString(context.label) || null,
      },
      custom,
      lineItem: asString(endpoint.lineitem) || null,
      agsScopes: asStringArray(endpoint.scope),
      targetLinkUri: asString(payload[LTI_CLAIM.targetLinkUri]) || null,
    },
  };
}

/**
 * The LIS role, as a role here.
 *
 * Two decisions worth stating. **A `Learner` who is also an `Instructor` is an
 * instructor**, because the more capable role is the one that was actually
 * granted — the reverse reading would silently take an instructor's own courses
 * away. And **an unmapped role is the deployment's default**, not a refusal: LIS
 * adds role values over time, and a product that refused a launch the moment a
 * platform gained a new vocabulary would break on somebody else's release.
 */
export function ltiRoleOf(roles: readonly string[], fallback: SsoRole = "STUDENT"): { role: SsoRole; mapped: boolean } {
  const suffixes = roles.map((role) => role.split("#").pop() ?? "").filter(Boolean);
  if (suffixes.some((suffix) => ADMIN_ROLE_SUFFIXES.includes(suffix))) return { role: "ADMIN", mapped: true };
  if (suffixes.some((suffix) => INSTRUCTOR_ROLE_SUFFIXES.includes(suffix))) return { role: "INSTRUCTOR", mapped: true };
  if (suffixes.some((suffix) => LEARNER_ROLE_SUFFIXES.includes(suffix))) return { role: "STUDENT", mapped: true };
  return { role: fallback, mapped: false };
}

const ADMIN_ROLE_SUFFIXES = ["Administrator", "SysAdmin"];
const INSTRUCTOR_ROLE_SUFFIXES = [
  "Instructor",
  "ContentDeveloper",
  "TeachingAssistant",
  "Faculty",
  "Staff",
  "Mentor",
];
const LEARNER_ROLE_SUFFIXES = ["Learner", "Member", "Student", "User", "None"];

/** Whether the LIS role could be read as a role here, for the wording a launch shows. */
export function roleReason(launch: LtiLaunch): string {
  if (launch.roleMapped) return `the platform sent the role ${launch.roles.join(", ")}`;
  return "the platform sent no role this deployment recognises, so the default applies";
}

/* -------------------------------------------------------------------------- */
/*  The launch's own state, round-tripped in a cookie                          */
/* -------------------------------------------------------------------------- */

export interface LtiState {
  state: string;
  nonce: string;
  returnTo: string;
  at: string;
}

export function isLtiState(value: unknown): value is LtiState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.state === "string" &&
    state.state.length > 0 &&
    typeof state.nonce === "string" &&
    state.nonce.length > 0 &&
    typeof state.returnTo === "string" &&
    typeof state.at === "string"
  );
}

export function ltiStateExpired(state: LtiState, now: string): boolean {
  return new Date(now).getTime() - new Date(state.at).getTime() > LTI_STATE_TTL_SECONDS * 1000;
}

/* -------------------------------------------------------------------------- */
/*  What an attempt inherits, so a score can find its way back                 */
/* -------------------------------------------------------------------------- */

/**
 * The launch facts an attempt carries.
 *
 * Stored on the attempt rather than in the session because grading happens later,
 * from a different request, and sometimes from a different person (an instructor
 * re-grading): the line item has to be a property of the *attempt*, not of
 * whoever is signed in when the score is written.
 */
export interface LtiLaunchFacts {
  issuer: string;
  subject: string;
  /**
   * The address the platform asserted, kept so an attempt can refuse a launch
   * context that belongs to somebody else: a browser can be signed in as one person
   * and still carry the cookie of another's launch.
   */
  email: string;
  deploymentId: string;
  /** The AGS line item, or null when the platform did not name one. */
  lineItem: string | null;
  /** What the platform said we may do with the line item. */
  agsScopes: string[];
  /** The platform's course context, kept as identity rather than as a name. */
  contextId: string | null;
  resourceLinkId: string;
  at: string;
}

export function isLtiLaunchFacts(value: unknown): value is LtiLaunchFacts {
  if (typeof value !== "object" || value === null) return false;
  const facts = value as Record<string, unknown>;
  return (
    typeof facts.issuer === "string" &&
    typeof facts.subject === "string" &&
    typeof facts.email === "string" &&
    typeof facts.at === "string"
  );
}

export function ltiLaunchFacts(launch: LtiLaunch, at: string): LtiLaunchFacts {
  return {
    issuer: launch.issuer,
    subject: launch.subject,
    email: launch.email,
    deploymentId: launch.deploymentId,
    lineItem: launch.lineItem,
    agsScopes: launch.agsScopes,
    contextId: launch.context.id,
    resourceLinkId: launch.resourceLink.id,
    at,
  };
}

export function launchFactsExpired(facts: LtiLaunchFacts, now: string): boolean {
  return new Date(now).getTime() - new Date(facts.at).getTime() > LTI_LAUNCH_TTL_SECONDS * 1000;
}

/* -------------------------------------------------------------------------- */
/*  Assignment & Grade Services                                                */
/* -------------------------------------------------------------------------- */

/** Whether the platform granted the one scope a passback needs. */
export function mayWriteScore(scopes: readonly string[] | undefined | null): boolean {
  return Array.isArray(scopes) && scopes.includes(LTI_AGS_SCORE_SCOPE);
}

/** Where a score goes: the line item the launch named, with `/scores` appended. */
export function agsScoreUrl(lineItem: string): string {
  return `${lineItem.replace(/\/+$/, "")}/scores`;
}

export interface AgsScoreInput {
  score: number;
  maxScore: number;
  subject: string;
  comment?: string | null;
  /** When the attempt was graded, so the LMS orders it the way we did. */
  gradedAt: string;
}

/**
 * The score body AGS expects.
 *
 * The two `*Progress` fields are not decoration: a platform shows a score as
 * provisional until the tool says it is `FullyGraded`, so omitting them is how a
 * grade arrives and never counts. `scoreMaximum` is sent even when it is zero
 * because the specification requires it, and there is no honest alternative to
 * sending it.
 */
export function agsScore(input: AgsScoreInput): Record<string, unknown> {
  return {
    userId: input.subject,
    scoreGiven: input.score,
    scoreMaximum: input.maxScore,
    activityProgress: "Completed",
    gradingProgress: "FullyGraded",
    timestamp: input.gradedAt,
    ...(input.comment ? { comment: input.comment } : {}),
  };
}

/** The client-assertion claims for the token that authorizes a score write. */
export function agsTokenAssertion(input: {
  issuer: string;
  clientId: string;
  audience: string;
  jti: string;
  nowSec: number;
  ttlSec: number;
}): Record<string, unknown> {
  return {
    iss: input.issuer,
    sub: input.clientId,
    aud: input.audience,
    jti: input.jti,
    iat: input.nowSec,
    exp: input.nowSec + input.ttlSec,
  };
}

/** The form body of the token request, once the assertion has been signed. */
export function agsTokenForm(assertion: string, scope = LTI_AGS_SCORE_SCOPE): Record<string, string> {
  return {
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
    scope,
  };
}

/**
 * Why a grade was not passed back, in words a person can act on.
 *
 * Kept here rather than at the call site so the console and the delivery log
 * cannot describe the same non-delivery differently, which is exactly how a
 * missing grade becomes a mystery.
 */
export function passbackRefusal(launch: LtiLaunchFacts | null, configured: boolean): string | null {
  if (!launch?.lineItem) return "This attempt did not come from a learning platform, so there is nowhere to send it.";
  if (!mayWriteScore(launch.agsScopes)) {
    return "The platform did not grant the score scope on this launch, so the grade stays here.";
  }
  if (!configured) return "This deployment has no platform credentials, so it cannot ask for permission to write a score.";
  return null;
}
