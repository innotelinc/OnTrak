/**
 * SSO start (M2).
 *
 * `GET /api/sso/start?tenant=acme` begins the OIDC authorization-code flow for a
 * tenant: it discovers the IdP, builds an authorization request with CSRF
 * `state`, a replay `nonce` and a PKCE challenge, stores that state in a signed
 * cookie, and redirects the browser to the IdP. On return, `/api/sso/callback`
 * finishes the handshake.
 *
 * The tenant comes from the URL because that is how a user reaches SSO — they
 * type a workspace, not a tenant id. Everything after the slug lookup is
 * per-tenant config, so a mis-typed workspace cannot start a handshake against
 * someone else's IdP.
 *
 * SAML is deliberately refused with a clear message rather than silently doing
 * nothing: the connection is stored as SAML, but only the OIDC flow is wired.
 */

import { NextResponse, type NextRequest } from "next/server";

import { identityServicesFor, prisma } from "../../../../lib/db";
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
  const slug = (request.nextUrl.searchParams.get("tenant") ?? "").trim().toLowerCase();
  if (!slug) return fail(request, "Enter your workspace to sign in with single sign-on.");

  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) return fail(request, `Unknown workspace "${slug}".`);

  const connection = await identityServicesFor().connectionFor(tenant.id);
  if (!connection) return fail(request, `"${slug}" has no single sign-on configured.`);
  if (connection.protocol !== "OIDC") {
    return fail(request, `"${slug}" is configured for SAML; only OIDC is supported today.`);
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
    tenantId: tenant.id,
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
