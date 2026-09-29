import { randomBytes } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

/**
 * Begin a Cerulean sign-in.
 *
 * `state`, the replay `nonce` and the PKCE verifier travel in one short-lived
 * signed cookie — not in memory, because a restart between the redirect and the
 * callback would break every sign-in in flight, and not in a table, because that
 * would be a third thing to clean up for a ten-minute window.
 *
 * Nothing is trusted until the callback: this route's whole job is to hand the
 * browser to the provider with enough state to recognise it on the way back. The
 * provider's hostname is in the estate's zone, so the link works from a browser
 * on the LAN and from one outside it, and the redirect URI is registered byte for
 * byte against `ONTRAK_PORTAL_PUBLIC_URL`.
 */

import { portalConfig, portalUrl, ssoConfigured } from "@/lib/config";
import { authorizationUrl, OidcError } from "@/lib/oidc-client";
import { safeReturnTo, type AuthorizationState } from "@/lib/oidc-rules";
import { setSsoState } from "@/lib/session";

export const dynamic = "force-dynamic";

function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function refuse(request: NextRequest, reason: string): NextResponse {
  const target = portalUrl(request.url, "/login");
  target.searchParams.set("error", reason);
  return NextResponse.redirect(target, 303);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = portalConfig();
  if (!ssoConfigured(config)) {
    return refuse(request, "single sign-on is not configured for this portal");
  }

  const state: AuthorizationState = {
    state: token(24),
    nonce: token(24),
    verifier: token(48),
    return_to: safeReturnTo(request.nextUrl.searchParams.get("next")),
    issued_at: Math.floor(Date.now() / 1000),
  };

  try {
    const target = await authorizationUrl(state);
    // The cookie is written before the redirect so the callback can never arrive
    // before its own state did.
    await setSsoState(state);
    return NextResponse.redirect(target, 303);
  } catch (cause) {
    const reason = cause instanceof OidcError
      ? cause.message
      : `the sign-in could not be started: ${cause instanceof Error ? cause.message : String(cause)}`;
    return refuse(request, reason);
  }
}
