/**
 * The OIDC decisions, separated from the network calls that feed them.
 *
 * `oidc-client.ts` does the four HTTP calls; this file decides what the answers
 * *mean*, and every refusal lives here so it can be tested without a provider.
 * The split matters because the interesting failures are not "the provider was
 * down" — they are "the assertion was valid but for somebody else", and those are
 * logic bugs that a mocked network would happily hide.
 *
 * The checks, and why each one is not optional:
 *
 *   * **issuer** — the provider has to be the one we asked. Authentik advertises
 *     its base URL as the issuer while an application's endpoints live under
 *     `/application/o/<slug>/`, so the *application-scoped* issuer is what has to
 *     match, and a mismatch here is the difference between "the Network's directory"
 *     and "any directory at all".
 *   * **audience** — the token must have been minted for this client. Without it,
 *     an assertion issued to the training range would be a valid sign-in here.
 *   * **nonce** — the value this portal put in the authorization request. It is
 *     what makes a captured assertion useless on replay.
 *   * **expiry / issued-at / not-before** — with a small skew allowance, because
 *     the two machines do not share a clock and refusing a token three seconds
 *     early is an outage blamed on the network.
 *   * **email verified** — an unverified address is an address somebody typed.
 *     Adopting it would let a person claim another's account by editing a profile.
 *
 * PKCE (S256) is generated here and checked by the provider on the token
 * endpoint; the verifier is carried in the signed state cookie.
 */

import type { Role } from "./portal-rules";

export const STATE_COOKIE = "ontrak_portal_state";
export const SESSION_COOKIE = "ontrak_portal_session";
export const STATE_TTL_SECONDS = 600;
export const SESSION_TTL_SECONDS = 12 * 3600;
/** Small, and only to absorb clock drift between two machines. */
export const CLOCK_SKEW_SECONDS = 90;

export interface AuthorizationState {
  state: string;
  nonce: string;
  verifier: string;
  /** Where inside the portal the browser should land after the handshake. */
  return_to: string;
  issued_at: number;
}

export function isAuthorizationState(value: unknown): value is AuthorizationState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AuthorizationState>;
  return (
    typeof candidate.state === "string" && candidate.state.length > 0 &&
    typeof candidate.nonce === "string" && candidate.nonce.length > 0 &&
    typeof candidate.verifier === "string" && candidate.verifier.length > 0 &&
    typeof candidate.issued_at === "number"
  );
}

/**
 * Only ever redirect to a path inside this deployment.
 *
 * An open redirect on the callback turns the portal's own sign-in page into a
 * phishing page: the link is real, the certificate is right, and the destination
 * is somebody else's. A single leading slash and no second one is the whole rule.
 */
export function safeReturnTo(value: string | null | undefined, fallback = "/"): string {
  const candidate = (value ?? "").trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return fallback;
  return candidate;
}

export interface IdTokenClaims {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  azp?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  groups?: unknown;
}

export type ClaimCheck =
  | { ok: true; subject: string; email: string; name: string; groups: string[] }
  | { ok: false; reason: string };

/**
 * Everything that must hold before a claim is believed.
 *
 * The reason strings are written to be shown to the person who is trying to sign
 * in — "the token expired" tells an operator nothing, and "the provider's clock
 * and this server's disagree" tells them what to fix.
 */
/**
 * The issuer to hand a verifier that compares it **byte for byte**.
 *
 * Authentik advertises its application-scoped issuer with a trailing slash
 * (`https://auth.example/application/o/ontrak/`) and puts exactly that string in
 * the ID token's `iss`. This portal stores the issuer normalized — and should,
 * because `.env` has three readers that do not agree about a trailing slash — but
 * `jose`'s `issuer` option is a literal comparison, so handing it the normalized
 * form rejects a token that is entirely valid with `unexpected "iss" claim value`,
 * *after* the password has been typed.
 *
 * So: the string the provider advertised, as it advertised it, whenever it names
 * the same issuer the configuration does. `checkClaims` still compares the two
 * with the slash ignored, so a discovery document that renames the issuer is
 * refused there rather than quietly accepted here.
 */
export function verificationIssuer(advertised: string | undefined,
                                  configured: string): string {
  const named = (advertised ?? "").trim();
  if (!named) return configured;
  return named.replace(/\/+$/, "") === configured.replace(/\/+$/, "")
    ? named
    : configured;
}

export function checkClaims(
  claims: IdTokenClaims,
  options: {
    issuer: string;
    clientId: string;
    nonce: string;
    now?: number;
    allowedDomains?: readonly string[];
  },
): ClaimCheck {
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const issuer = (claims.iss ?? "").replace(/\/+$/, "");
  const expected = options.issuer.replace(/\/+$/, "");
  if (!issuer || issuer !== expected) {
    return { ok: false, reason: `the assertion was issued by ${issuer || "nobody"}, not ${expected}` };
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(options.clientId)) {
    return { ok: false, reason: "the assertion was not issued to this portal" };
  }
  // With more than one audience the token proves less than it looks like it does
  // unless `azp` names us as the authorized party.
  if (audiences.length > 1 && claims.azp !== options.clientId) {
    return { ok: false, reason: "the assertion has several audiences and no matching azp" };
  }

  if (!claims.nonce || claims.nonce !== options.nonce) {
    return { ok: false, reason: "the assertion's nonce did not match this sign-in" };
  }

  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < now) {
    return { ok: false, reason: "the assertion has expired" };
  }
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_SECONDS > now) {
    return { ok: false, reason: "the assertion was issued in the future — the provider's clock and this server's disagree" };
  }
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > now) {
    return { ok: false, reason: "the assertion is not valid yet" };
  }

  const subject = (claims.sub ?? "").trim();
  if (!subject) return { ok: false, reason: "the assertion carried no subject" };

  const email = (claims.email ?? "").trim().toLowerCase();
  if (!email) return { ok: false, reason: "the assertion carried no email address" };
  // Absent means "the provider did not say otherwise"; an explicit false is a
  // refusal, and this is the field that stops one person adopting another's
  // account by editing a profile.
  if (claims.email_verified === false) {
    return { ok: false, reason: "the provider has not verified that email address" };
  }

  const domains = options.allowedDomains ?? [];
  if (domains.length > 0) {
    const domain = email.split("@").pop() ?? "";
    if (!domains.map((entry) => entry.trim().toLowerCase()).includes(domain)) {
      return { ok: false, reason: `the ${domain} domain is not allowed to sign in here` };
    }
  }

  const raw = claims.groups;
  const groups = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
    : typeof raw === "string" && raw.trim()
      ? [raw.trim()]
      : [];

  return {
    ok: true,
    subject,
    email,
    name: (claims.name ?? claims.preferred_username ?? email).trim() || email,
    groups,
  };
}

/** The portal's own cookie session, as carried in the signed JWT. */
export interface PortalSession {
  sub: string;
  email: string;
  name: string;
  role: Role;
  /** Which groups produced the role. Shown on the account card, never trusted. */
  groups: string[];
  /**
   * Where the role came from. `cerulean` for SSO, `sync` for a local sign-in
   * through OnTrak Sync's account table, `password` for the break-glass account
   * in `.env`. The portal shows this so "why do I have this role" is answerable.
   */
  source: "cerulean" | "sync" | "password";
  /**
   * The provider group that produced the role, or null when none did.
   *
   * Carried so the dashboard can say "no group of yours maps to a role, so you
   * have the default" rather than leaving somebody to wonder why their product
   * is not on the page. It is a display fact, never an authorisation input.
   */
  matched_group?: string | null;
  issued_at: number;
}

export function isPortalSession(value: unknown): value is PortalSession {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PortalSession>;
  return (
    typeof candidate.sub === "string" && candidate.sub.length > 0 &&
    typeof candidate.email === "string" &&
    typeof candidate.role === "string" &&
    typeof candidate.issued_at === "number" &&
    typeof candidate.source === "string"
  );
}
