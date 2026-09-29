/**
 * The sign-in form's rules, kept pure.
 *
 * Everything here can be decided without a database, which is what makes the parts
 * that matter — what counts as a well-formed attempt, and what a refusal is allowed
 * to say — testable directly rather than through a login.
 */

/**
 * One attempt, as the form submits it.
 *
 * `organization` is optional on purpose: a single-tenant deployment should not make
 * somebody type a workspace to reach their own console. When it *is* given it is
 * honoured, because an identifier is unique within an organization rather than
 * across them.
 */
export interface SignInInput {
  identifier: string;
  password: string;
  /** The TOTP code, when the identity has a confirmed authenticator. */
  code?: string;
  organization?: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}

/**
 * The one sentence every credential failure gets.
 *
 * "No account by that name" and "that password is wrong" are different facts, and
 * telling them apart is how a login form becomes a way to ask "does this person have
 * an account here". It is deliberately also the sentence used for a *deactivated*
 * identity: whether somebody was deactivated is not a stranger's business.
 */
export const SIGN_IN_FAILURE = "That email and password do not match an account.";

/**
 * What is wrong with this submission *as a form*, or `null`.
 *
 * Only the shape of the input is judged here — never whether the account exists.
 * A missing field is about the page, and a page can say so; anything else would be
 * about the account and is covered by `SIGN_IN_FAILURE`.
 */
export function signInProblem(input: SignInInput): string | null {
  if (!input.identifier || !input.identifier.trim()) return "Enter the email address for your account.";
  if (!input.password) return "Enter your password.";
  // Length rather than composition: this rejects nonsense (a paste of a whole
  // document, a runaway script) without imposing a password policy at the door,
  // which is the wrong place for one — the rule belongs where a password is set.
  if (input.password.length > 4096) return "That password is too long to be a password.";
  const code = input.code?.trim() ?? "";
  if (code && !/^[0-9]{6,8}$/.test(code)) return "The code is six digits from your authenticator app.";
  return null;
}

/** Trim and case-fold an identifier, the way the store looks one up. */
export function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}
