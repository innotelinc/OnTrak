/**
 * SSO callback (M2).
 *
 * The IdP redirects the browser here with a code. The route:
 *
 *   1. recovers the signed authorization state (CSRF `state`, replay `nonce`,
 *      PKCE verifier) and refuses anything that does not match;
 *   2. exchanges the code and verifies the ID token;
 *   3. maps the token's claims into `IdentityClaims` and hands them to
 *      `IdentityService.signIn`, which decides the role, provisions the user on
 *      a first sign-in and audits the attempt;
 *   4. issues the ordinary Tix session and sends the user where they were going.
 *
 * Nothing here re-implements a decision: every check is a pure function in
 * `oidc-rules.ts` or the identity service, so this file is only the wiring.
 */

import { NextResponse, type NextRequest } from "next/server";

import { identityServicesFor } from "../../../../lib/db";
import { HttpOidcClient, OIDC_CLIENT_SECRET_ENV } from "../../../../lib/oidc-client";
import { extractOidcClaims, homePathForRole } from "../../../../lib/oidc-rules";
import { createTixSession } from "../../../../lib/session";
import { clearSsoState, readSsoState } from "../../../../lib/sso-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function fail(request: NextRequest, message: string): NextResponse {
  const url = new URL("/sign-in", request.nextUrl.origin);
  url.searchParams.set("error", message);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // The IdP reports a refusal (or a user cancelling) as query params.
  const providerError = request.nextUrl.searchParams.get("error");
  if (providerError) {
    const description = request.nextUrl.searchParams.get("error_description") ?? providerError;
    await clearSsoState();
    return fail(request, `Single sign-on failed: ${description}.`);
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state) return fail(request, "Single sign-on returned no authorization code.");

  const pending = await readSsoState();
  await clearSsoState();
  if (!pending || pending.state !== state) {
    return fail(request, "This single sign-on request could not be verified. Start again.");
  }

  const connection = await identityServicesFor().connectionFor(pending.tenantId);
  if (!connection) return fail(request, "This workspace no longer has single sign-on configured.");

  const client = new HttpOidcClient();
  const redirectUri = new URL("/api/sso/callback", request.nextUrl.origin).toString();

  let token;
  try {
    token = await client.exchangeCode({
      discovery: await client.discover(connection.issuer),
      clientId: connection.clientId,
      clientSecret: process.env[OIDC_CLIENT_SECRET_ENV] ?? null,
      code,
      redirectUri,
      codeVerifier: pending.codeVerifier,
    });
  } catch (error) {
    return fail(request, error instanceof Error ? error.message : "Could not complete single sign-on.");
  }

  const claims = extractOidcClaims(token.payload, { issuer: connection.issuer, nonce: pending.nonce });
  if (!claims.ok) return fail(request, claims.reason);

  const signedIn = await identityServicesFor().signIn(pending.tenantId, claims.claims);
  if (!signedIn.ok) return fail(request, signedIn.error);

  const { user } = signedIn.value;
  await createTixSession({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email, name: user.displayName });

  return NextResponse.redirect(new URL(pending.returnTo || homePathForRole(user.role), request.nextUrl.origin));
}
