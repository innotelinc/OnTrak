/**
 * The family's own address, as a product prints it under its name in the masthead.
 *
 * `ONTRAK_PORTAL_BASE_DOMAIN` is the portal's variable for the family's name — the
 * same one its product tiles link against — and it is read here rather than in each
 * file because the masthead is drawn in two places (the login gate's frame and the
 * signed-in console's) and two copies of this parsing is how one of them ends up
 * printing `"ontrak.innotel.us"` with the quotes, or a trailing dot nothing resolves.
 *
 * It is deliberately *not* this container's address: behind a proxy that would be
 * `127.0.0.1:8421`, which is a worse thing to print than the family's name.
 *
 * A server-only value, so only a server component may call this — a client component
 * reading it would name one host in the server's markup and another after hydration.
 */
export function familyDomain(): string {
  return (process.env.ONTRAK_PORTAL_BASE_DOMAIN ?? "ontrak.innotel.us")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\.+$/, "");
}
