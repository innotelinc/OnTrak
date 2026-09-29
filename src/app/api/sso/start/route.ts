/**
 * SSO start.
 *
 * `GET /api/sso/start?next=/student` begins the OIDC authorization-code flow: it
 * discovers the provider, builds an authorization request with a CSRF `state`, a
 * replay `nonce` and an S256 PKCE challenge, stores that state in one signed
 * cookie, and redirects the browser to the provider. `/api/sso/callback` finishes
 * the handshake on return.
 *
 * There is no tenant slug here, unlike OnTrak Tix: this deployment has exactly one
 * provider, named by its environment, so the route has nothing to look up and
 * nothing a caller could point somewhere else.
 */

import { NextResponse, type NextRequest } from "next/server";

import { HttpOidcClient, createPkcePair, randomUrlSafe } from "../../../../lib/oidc-client";
import {
  activeSsoConfig,
  buildAuthorizationUrl,
  deploymentOrigin,
  ssoConfigIssues,
  ssoRedirectUri,
} from "../../../../lib/oidc-rules";
import { safeRelativePath } from "../../../../lib/auth-rules";
import { setSsoState } from "../../../../lib/sso-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function originOf(request: NextRequest): string {
  return deploymentOrigin(process.env.ONTRAK_TRAINING_BASE_URL, request.nextUrl.origin);
}

function fail(request: NextRequest, message: string): NextResponse {
  const url = new URL("/login", originOf(request));
  url.searchParams.set("error", message);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = activeSsoConfig();
  if (!config) {
    const issues = ssoConfigIssues();
    return fail(
      request,
      issues[0] ?? "This deployment does not have single sign-on configured.",
    );
  }

  const client = new HttpOidcClient();
  let discovery;
  try {
    discovery = await client.discover(config.issuer);
  } catch (error) {
    return fail(request, error instanceof Error ? error.message : "Could not reach the identity provider.");
  }

  const pkce = createPkcePair();
  const state = randomUrlSafe(24);
  const nonce = randomUrlSafe(24);

  await setSsoState({
    state,
    nonce,
    codeVerifier: pkce.verifier,
    // Only a same-site path may survive as a destination, so a crafted `next`
    // cannot turn the callback into an open redirect.
    returnTo: safeRelativePath(request.nextUrl.searchParams.get("next")) ?? "",
    at: new Date().toISOString(),
  });

  const authorizationUrl = buildAuthorizationUrl(discovery, {
    clientId: config.clientId,
    redirectUri: ssoRedirectUri(originOf(request)),
    scopes: config.scopes,
    state,
    nonce,
    codeChallenge: pkce.challenge,
  });

  return NextResponse.redirect(authorizationUrl);
}
