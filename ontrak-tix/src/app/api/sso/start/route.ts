/**
 * SSO start (M2) — single desk.
 *
 * `GET /api/sso/start` begins the OIDC authorization-code flow for this desk's
 * configured identity provider: it discovers the IdP, builds an authorization
 * request with CSRF `state`, a replay `nonce` and a PKCE challenge, stores that
 * state in a signed cookie, and redirects the browser to the IdP. On return,
 * `/api/sso/callback` finishes the handshake.
 *
 * There is no workspace to type here: this deployment is single-desk, so the
 * sign-in page's button hands the browser straight to the one configured IdP.
 * A second way in is a second place a password can be wrong, a second place it
 * can be reused, and a second place to audit; the whole premise of the Network
 * is that a person is who the directory says they are.
 *
 * SAML is deliberately refused with a clear message rather than silently doing
 * nothing: the connection is stored as SAML, but only the OIDC flow is wired.
 */

import { NextResponse, type NextRequest } from "next/server";

import { identityServicesFor } from "../../../../lib/db";

/*
 * This route no longer reads `prisma` directly: the desk's single identity
 * provider is reached through `identityServicesFor().connectionFor`, and the
 * desk slug comes from `ONTRAK_TIX_DEFAULT_TENANT`, not from a workspace typed
 * by a person. The workspace/prisma path is gone with the multi-tenant feature.
 */
import { HttpOidcClient, createPkcePair, randomUrlSafe } from "../../../../lib/oidc-client";
import { buildAuthorizationUrl, deploymentOrigin, safeReturnTo, ssoRedirectUri } from "../../../../lib/oidc-rules";
import { setSsoState } from "../../../../lib/sso-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Where this deployment is, which is not necessarily where this request arrived.
 * See `deploymentOrigin` — the redirect URI has to name the address the provider
 * was given, and the post-sign-in redirect has to name one the browser can reach.
 */
function originOf(request: NextRequest): string {
  return deploymentOrigin(process.env.ONTRAK_TIX_BASE_URL, request.nextUrl.origin);
}

function fail(request: NextRequest, message: string): NextResponse {
  const url = new URL("/sign-in", originOf(request));
  url.searchParams.set("error", message);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // This deployment is single-desk: the one identity provider is the one stored
  // for this desk, read off the desk's own tenant rather than a slug typed by a
  // person. The sign-in page already hands the browser here from the SSO button,
  // so nobody reaches this route with a `tenant` they typed.
  const defaultTenant = (process.env.ONTRAK_TIX_DEFAULT_TENANT ?? "").trim().toLowerCase();
  if (!defaultTenant) return fail(request, "Single sign-on is not configured for this deployment.");

  const connection = await identityServicesFor().connectionFor(defaultTenant);
  if (!connection) return fail(request, "Single sign-on is not configured for this deployment.");
  if (connection.protocol !== "OIDC") {
    return fail(request, "This deployment is configured for SAML; only OIDC is supported today.");
  }

  const client = new HttpOidcClient();
  let discovery;
  try {
    discovery = await client.discover(connection.issuer);
  } catch (error) {
    return fail(request, error instanceof Error ? error.message : "Could not reach the identity provider.");
  }

  const pkce = createPkcePair();
  const state = randomUrlSafe(24);
  const nonce = randomUrlSafe(24);
  const redirectUri = ssoRedirectUri(originOf(request));

  await setSsoState({
    state,
    nonce,
    codeVerifier: pkce.verifier,
    tenantId: defaultTenant,
    returnTo: safeReturnTo(request.nextUrl.searchParams.get("returnTo")) ?? "",
    at: new Date().toISOString(),
  });

  const authorizationUrl = buildAuthorizationUrl(discovery, {
    clientId: connection.clientId,
    redirectUri,
    scopes: connection.scopes,
    state,
    nonce,
    codeChallenge: pkce.challenge,
  });

  return NextResponse.redirect(authorizationUrl);
}
