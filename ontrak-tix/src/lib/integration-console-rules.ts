/**
 * Integrations console rules (M6): where a readable-once secret lives, and how it
 * is read back.
 *
 * Two M6 values can be read exactly once — a minted API token and a webhook
 * signing secret, both of which their services return at creation and never
 * again — so there has to be somewhere for them to be between the action that
 * created them and the person who asked copying them down.
 *
 * That somewhere is a short-lived, path-scoped `httpOnly` cookie, and this module
 * owns the three facts about it so the action that sets it and the page that shows
 * it cannot disagree:
 *
 *   1. **The name.** It lives here rather than in the action module because a
 *      `"use server"` file may only export async functions, and a page that
 *      imported the constant from one would not build.
 *   2. **The scope.** One path, so the cookie is not sent with every request to the
 *      rest of the product, and fifteen minutes, because a secret that outlives the
 *      visit is one that a shared machine leaves behind.
 *   3. **The id it belongs to.** The value carries the id of the token or endpoint
 *      it was revealed for, and {@link revealedSecret} answers only for a matching
 *      one — so a cookie left over from an earlier visit, or from a different
 *      endpoint's rotation, renders nothing rather than the wrong secret beside the
 *      wrong name.
 *
 * A cookie rather than a query parameter on purpose: a secret in a URL ends up in
 * browser history, in the `Referer` header, and in every access log between here
 * and the browser. Pure and framework-free, so the parse is a unit and not a
 * guess.
 */

/** The cookie holding a minted API token, readable once. */
export const REVEAL_COOKIE = "ontrak_tix_minted_token";
/** The cookie holding a webhook signing secret, readable once. */
export const REVEAL_WEBHOOK_COOKIE = "ontrak_tix_minted_webhook";
/** The console is the only path either cookie is scoped to. */
export const REVEAL_PATH = "/admin/integrations";
/** How long an unclaimed secret stays where the console can show it. */
export const REVEAL_TTL_SECONDS = 15 * 60;

/** The two things in the console a secret can be revealed for. */
export type RevealKind = "token" | "webhook";

/** Which cookie a reveal kind uses, so a form can name one thing rather than infer two. */
export function revealCookie(kind: RevealKind): string {
  return kind === "webhook" ? REVEAL_WEBHOOK_COOKIE : REVEAL_COOKIE;
}

/**
 * The secret a cookie holds, if it is the one the page was told to reveal.
 *
 * Returns `null` for anything unreadable — an absent cookie, a hand-edited value,
 * or a value belonging to a different token or endpoint. Two secrets shown beside
 * each other under the wrong heading is worse than showing none, because the one
 * that gets copied is the one that then does not work.
 */
export function revealedSecret(raw: string | undefined, expectedId: string | undefined): string | null {
  if (!raw || !expectedId) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; secret?: unknown };
    return parsed.id === expectedId && typeof parsed.secret === "string" && parsed.secret !== ""
      ? parsed.secret
      : null;
  } catch {
    return null;
  }
}
