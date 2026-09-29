/**
 * Authentication form rules, as pure functions.
 *
 * The sign-in / sign-up actions are thin wrappers around these: the zod schemas
 * that validate the fields, the join-code normalisation the roster lookup uses,
 * and the redirect guard. None of it touches the database, so the whole
 * "register with a class code" path can be tested without one.
 */

import { z } from "zod";

export const MIN_PASSWORD_LENGTH = 8;

/**
 * The session cookie's name.
 *
 * It lives here, beside the other pure rules, rather than in `auth.ts`, for the
 * same reason the single sign-on state cookie's name lives in `oidc-rules.ts`: a
 * live test has to look for it on a raw HTTP response, and `auth.ts` touches
 * `next/headers` and cannot be imported outside the server runtime.
 */
export const SESSION_COOKIE = "ontrak_training_session";

/**
 * The single password policy, shared by sign-up and the admin user form so the
 * minimum can never drift between them. Returns a problem message, or `null`
 * when the password is acceptable.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

/** Email + password, shared by sign-in and sign-up. */
export const CREDENTIALS = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z.string().min(MIN_PASSWORD_LENGTH, `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`),
});

/** Sign-up adds a name and an optional class join code. */
export const REGISTRATION = CREDENTIALS.extend({
  name: z.string().trim().min(2, "Tell us your name.").max(80),
  joinCode: z.string().trim().optional(),
});

export function allowSelfRegistration(): boolean {
  return (process.env.NEXT_PUBLIC_ALLOW_SELF_REGISTRATION ?? "true") !== "false";
}

/* -------------------------------------------------------------------------- */
/*  Whether the session cookie may travel only over TLS                       */
/* -------------------------------------------------------------------------- */

export type CookieSecurity = "auto" | "always" | "never";

/**
 * Read how a deployment wants the `Secure` flag decided (`AUTH_COOKIE_SECURE`).
 *
 * The flag used to be guessed from `NODE_ENV === "production"`, which is wrong for
 * the way this app is deployed: the compose stack serves plain HTTP with
 * `NODE_ENV=production`, and a browser **refuses to store a `Secure` cookie from an
 * insecure origin** — everywhere but `localhost`. The result is a sign-in that works
 * on the developer's machine and silently signs everybody out from any other
 * address, which looks like a broken session rather than a dropped cookie.
 */
export function parseCookieSecurity(setting: string | null | undefined): CookieSecurity {
  const wanted = (setting ?? "").trim().toLowerCase();
  if (["always", "true", "1", "yes", "on"].includes(wanted)) return "always";
  if (["never", "false", "0", "no", "off"].includes(wanted)) return "never";
  return "auto";
}

/**
 * Whether to mark the cookie `Secure`, given what the request reports.
 *
 * `auto` follows the request rather than the build: `https` means the cookie can be
 * restricted to TLS, and anything else — including no report at all, which is what a
 * direct connection looks like — means it must not be, because a restricted cookie
 * over HTTP is simply discarded. A deployment behind a TLS terminator that does not
 * set `X-Forwarded-Proto` says so with `AUTH_COOKIE_SECURE=always` rather than being
 * guessed at.
 */
export function cookieIsSecure(
  setting: CookieSecurity,
  requestScheme: string | null | undefined,
): boolean {
  if (setting === "always") return true;
  if (setting === "never") return false;
  return (requestScheme ?? "").trim().toLowerCase() === "https";
}

/**
 * Normalise a class join code the way it is stored: trimmed and upper-cased.
 * A blank or missing code means "do not look one up", so it returns `null`.
 */
export function normalizeJoinCode(value: unknown): string | null {
  const code = String(value ?? "").trim().toUpperCase();
  return code.length > 0 ? code : null;
}

/**
 * Guard a `?next=` redirect. Only same-site relative paths are allowed, so a
 * crafted link cannot bounce a freshly signed-in user off-site. Rejects
 * protocol-relative (`//evil.test`) and absolute URLs.
 */
export function safeRelativePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

export const UNKNOWN_JOIN_CODE_MESSAGE =
  "That class code wasn't recognised. Check it with your instructor, or leave it blank.";

export type JoinOutcome =
  | { kind: "none" }
  | { kind: "join"; code: string }
  | { kind: "unknown"; code: string; message: string };

/**
 * Decide what a supplied class code means, given whether it matched a class.
 * A blank code is fine ("none"); a code that matched joins; a code that did not
 * is reported so the new student can correct it rather than silently landing in
 * a class-less account.
 */
export function joinOutcome(value: unknown, cohortFound: boolean): JoinOutcome {
  const code = normalizeJoinCode(value);
  if (!code) return { kind: "none" };
  return cohortFound
    ? { kind: "join", code }
    : { kind: "unknown", code, message: UNKNOWN_JOIN_CODE_MESSAGE };
}
