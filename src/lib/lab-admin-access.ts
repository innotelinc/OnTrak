import "server-only";

import { redirect } from "next/navigation";

import { ROLE_HOME, isStaff, requireSession, type SessionUser } from "@/lib/auth";

/**
 * The signed-in staff member the lab admin panel may be shown to, or a redirect.
 *
 * Middleware does not guard `/lab` — the lab is reached at a path the role guards do not
 * name, and its student pages deliberately serve any signed-in person — so the panel's own
 * pages ask here. Staff means `ADMIN` or `INSTRUCTOR`, which is the Python's
 * `require_instructor`: the panel is the estate around a class, and both roles run classes.
 *
 * A student is sent to their own home rather than shown a 403: a page that says where you
 * are allowed is more useful than one that says you are not, and it is what the app's own
 * middleware does for a role that reaches the wrong prefix. The check runs in every page
 * *and* in every action that writes, because a rule only the page enforces is a rule a POST
 * walks past.
 */
export async function requireLabStaff(): Promise<SessionUser> {
  const user = await requireSession();
  if (!isStaff(user)) redirect(ROLE_HOME[user.role]);
  return user;
}
