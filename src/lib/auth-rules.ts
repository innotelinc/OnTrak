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
