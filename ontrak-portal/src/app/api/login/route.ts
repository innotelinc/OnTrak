import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

/**
 * Password sign-in.
 *
 * The portal keeps no accounts. A username and password are handed to **OnTrak
 * Sync**, which owns the family's local account table and decides the role from
 * the one vocabulary every product shares. That is what "OnTrak Sync integrates
 * into all products" means concretely: the portal does not invent a second login,
 * it consumes the one that already exists.
 *
 * THE BREAK-GLASS ACCOUNT
 * -----------------------
 * `ONTRAK_PORTAL_ADMIN_USER`/`_PASSWORD` is optional and **disabled unless both
 * are set**. It exists because the honest failure mode of a portal whose only
 * sign-in is an SSO provider is that the provider being down takes the portal with
 * it — the estate already keeps a local login on the DNS console for exactly this
 * reason, since DNS is what resolves the IdP. It is a break-glass, not an
 * alternative: it grants ADMIN, it is compared in constant time, and every use is
 * logged by the reverse proxy as a request to this path. Leave it unset for a
 * deployment where Cerulean is always reachable.
 */

import { portalConfig } from "@/lib/config";
import { signInWithSync, roleOfSyncUser } from "@/lib/sync-client";
import type { PortalSession } from "@/lib/oidc-rules";
import { setSession } from "@/lib/session";

export const dynamic = "force-dynamic";

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // Length is compared first and is not secret — the *contents* are what must not
  // leak through timing, and `timingSafeEqual` refuses different lengths outright.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = portalConfig();

  let body: { username?: unknown; password?: unknown };
  try {
    body = (await request.json()) as { username?: unknown; password?: unknown };
  } catch {
    return NextResponse.json({ detail: "the request body was not JSON" }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return NextResponse.json({ detail: "a username and a password are required" },
      { status: 400 });
  }

  const breakGlassEnabled = Boolean(config.breakGlassUser && config.breakGlassPassword);
  if (breakGlassEnabled &&
      constantTimeEquals(username, config.breakGlassUser) &&
      constantTimeEquals(password, config.breakGlassPassword)) {
    const session: PortalSession = {
      sub: `break-glass:${username}`,
      email: "",
      name: `${username} (break-glass)`,
      role: "ADMIN",
      groups: [],
      source: "password",
      matched_group: null,
      issued_at: Math.floor(Date.now() / 1000),
    };
    await setSession(session);
    console.warn(
      `[ontrak-portal] break-glass sign-in used by ${username} from ` +
      `${request.headers.get("x-forwarded-for") ?? "an unknown address"}`,
    );
    return NextResponse.json({ ok: true, source: "password", role: "ADMIN" });
  }

  const result = await signInWithSync(username, password);
  if (!result.ok || !result.user) {
    const headers = result.retryAfter && result.retryAfter > 0
      ? { "Retry-After": String(result.retryAfter) }
      : undefined;
    return NextResponse.json({ detail: result.reason ?? "Invalid username or password." },
      { status: 401, headers });
  }

  const session: PortalSession = {
    sub: `sync:${result.user.id}`,
    email: result.user.email,
    name: result.user.display_name || result.user.username,
    role: roleOfSyncUser(result.user),
    groups: [],
    source: "sync",
    matched_group: null,
    issued_at: Math.floor(Date.now() / 1000),
  };
  await setSession(session);
  return NextResponse.json({ ok: true, source: "sync", role: session.role });
}
