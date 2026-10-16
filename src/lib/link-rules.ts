/**
 * A stored http(s) address, and why one is refused.
 *
 * This app keeps several addresses that were copied out of another product and pasted into a
 * form: the classroom a class is taught with, and the two survey links the funder's feedback
 * collection runs through (§4.5). They have the same four ways of being wrong, and the reason
 * each is a *refusal* rather than a warning is the same for all of them:
 *
 *   - **Not a URL at all** (a bare host, a path, whitespace): there is nothing to link to.
 *   - **Not http(s)** (`javascript:`, `data:`, `ftp:`): `javascript:` in an `href` runs script as
 *     the person who clicked, and a `data:` URL can render a look-alike page that belongs to
 *     nobody.
 *   - **Credentials in the URL** (`https://user:pass@host/…`): a secret in a field every class
 *     member reads, that an export prints and the audit log keeps, is not a secret.
 *   - **Anything else** the URL parser rejects.
 *
 * The rule lives here once, with the subject named in the refusal so a person is told which
 * field to fix; `classroom-rules.ts` and the feedback surfaces both read it rather than
 * carrying their own copy of a security check.
 */

/**
 * A stored address that is safe to render, or `null` when it is not one.
 *
 * The parsed `href` is returned, so what is stored and what is linked are the same string.
 */
export function httpLink(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  return parsed.href;
}

/** Why `httpLink` refused a value, in words that name the subject and what to change. */
export function httpLinkRefusal(raw: string | null | undefined, subject: string): string {
  const value = (raw ?? "").trim();
  if (value === "") return `A ${subject} address cannot be empty.`;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `“${value}” is not an absolute http(s) address; paste the ${subject}'s own link, including https://`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `“${value}” is a ${parsed.protocol.replace(":", "")} address, and a ${subject} must be served over http(s).`;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return `“${value}” carries a username and password. A ${subject} address is read by everyone it is shared with; reach the host with its own sign-in instead.`;
  }
  return `“${value}” is not a usable ${subject} address.`;
}
