import { NextResponse, type NextRequest } from "next/server";

/**
 * The provider sent the browser back. Verify everything, then sign in — or refuse.
 *
 * Every failure is a redirect to `/login?error=<why>` rather than a JSON body,
 * because the thing that always arrives here is a browser, and a browser shown
 * raw JSON has no way back to a login page. The reason strings come from
 * `checkClaims` and are written for the person who has to fix the configuration.
 *
 * The order of the checks is deliberate: the signature and the standard claims
 * (issuer, audience, nonce, expiry) are established first, because until they hold
 * nothing in the payload is worth reading; only then are the group claims used to
 * decide a role, and only then is a session issued.
 */

import { portalConfig, portalUrl, redirectUri, ssoConfigured } from "@/lib/config";
import { exchangeCode, OidcError, userinfo, verifyIdToken } from "@/lib/oidc-client";
import {
  checkClaims,
  safeReturnTo,
  type IdTokenClaims,
  type PortalSession,
} from "@/lib/oidc-rules";
import { roleFromGroups } from "@/lib/portal-rules";
import { clearSsoState, readSsoState, setSession } from "@/lib/session";

export const dynamic = "force-dynamic";

function refuse(request: NextRequest, reason: string): NextResponse {
  const target = portalUrl(request.url, "/login");
  target.searchParams.set("error", reason);
  const response = NextResponse.redirect(target, 303);
  // The failed handshake's state is spent; leaving it behind means the next
  // attempt can be confused by a cookie describing the previous one.
  response.cookies.delete("ontrak_portal_state");
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = portalConfig();
  if (!ssoConfigured(config) || !redirectUri(config)) {
    return refuse(request, "single sign-on is not configured for this portal");
  }

  const params = request.nextUrl.searchParams;
  const error = params.get("error");
  if (error) {
    return refuse(request, `${config.providerName} refused the sign-in (${error})`);
  }

  const pending = await readSsoState();
  if (!pending) {
    return refuse(request, "the sign-in expired or was replayed — start again");
  }
  const code = params.get("code");
  if (!code) return refuse(request, "the provider returned no authorization code");
  if (params.get("state") !== pending.state) {
    return refuse(request, "the sign-in state did not match");
  }

  let claims: IdTokenClaims;
  let accessToken = "";
  try {
    const tokens = await exchangeCode(code, pending.verifier);
    accessToken = tokens.access_token ?? "";
    claims = (await verifyIdToken(tokens.id_token ?? "")) as IdTokenClaims;

    // The ID token is authoritative. Authentik puts `groups` on the userinfo
    // endpoint for some flows, so an empty group list is the only thing this
    // fills in — it never overrides a claim the signed token carried.
    if (!claims.groups && accessToken) {
      const extra = await userinfo(accessToken);
      if (extra.groups) claims = { ...claims, groups: extra.groups };
    }
  } catch (cause) {
    return refuse(request, cause instanceof OidcError
      ? cause.message
      : `the sign-in could not be completed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const checked = checkClaims(claims, {
    issuer: config.issuer,
    clientId: config.clientId,
    nonce: pending.nonce,
    allowedDomains: config.allowedDomains,
  });
  if (!checked.ok) return refuse(request, checked.reason);

  const { role, matched } = roleFromGroups(checked.groups, config.roleMappings,
                                           config.defaultRole);

  const session: PortalSession = {
    sub: checked.subject,
    email: checked.email,
    name: checked.name,
    role,
    groups: checked.groups,
    source: "cerulean",
    // Recorded rather than inferred later: whether a group matched is a fact
    // about the assertion that was just verified, and re-deriving it from the
    // group list on every page render would be a second implementation of
    // `roleFromGroups` — the one thing this file exists to avoid.
    matched_group: matched,
    issued_at: Math.floor(Date.now() / 1000),
  };

  await setSession(session);
  await clearSsoState();

  const destination = safeReturnTo(pending.return_to);
  return NextResponse.redirect(portalUrl(request.url, destination), 303);
}
