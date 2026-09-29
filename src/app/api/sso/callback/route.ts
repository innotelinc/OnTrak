/**
 * SSO callback.
 *
 * The provider redirects the browser here with a code. The route:
 *
 *   1. recovers the signed authorization state (CSRF `state`, replay `nonce`, PKCE
 *      verifier) and refuses anything that does not match;
 *   2. exchanges the code and verifies the ID token against the provider's JWKS;
 *   3. maps the claims into what this deployment understands and resolves them to
 *      an account, provisioning on a first sign-in;
 *   4. issues the ordinary session cookie and sends the person where they were
 *      going.
 *
 * Nothing here re-implements a decision: every check is a pure function in
 * `oidc-rules.ts` or a step of `oidc-service.ts`, so this file is only the wiring.
 */

import { NextResponse, type NextRequest } from "next/server";

import { recordAudit } from "../../../../lib/audit";
import { createSession, ROLE_HOME } from "../../../../lib/auth";
import { HttpOidcClient } from "../../../../lib/oidc-client";
import {
  activeSsoConfig,
  authorizeSso,
  deploymentOrigin,
  extractOidcClaims,
  ssoRedirectUri,
} from "../../../../lib/oidc-rules";
import { resolveSsoSignIn, ssoDeniedAudit, ssoSignInAudit } from "../../../../lib/oidc-service";
import { prismaSsoStore } from "../../../../lib/oidc-store-prisma";
import { clearSsoState, readSsoState } from "../../../../lib/sso-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function originOf(request: NextRequest): string {
  return deploymentOrigin(process.env.ONTRAK_TRAINING_BASE_URL, request.nextUrl.origin);
}

/** Refuse, audit the refusal, and send the browser back to the sign-in page. */
async function refuse(request: NextRequest, provider: string, message: string): Promise<NextResponse> {
  await recordAudit(ssoDeniedAudit(provider, message));
  const url = new URL("/login", originOf(request));
  url.searchParams.set("error", message);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = activeSsoConfig();
  if (!config) return refuse(request, "unconfigured", "This deployment does not have single sign-on configured.");

  // The provider reports a refusal — or a person cancelling — as query parameters.
  const providerError = request.nextUrl.searchParams.get("error");
  if (providerError) {
    const description = request.nextUrl.searchParams.get("error_description") ?? providerError;
    await clearSsoState();
    return refuse(request, config.issuer, `Single sign-on failed: ${description}.`);
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state) return refuse(request, config.issuer, "Single sign-on returned no authorization code.");

  const pending = await readSsoState();
  await clearSsoState();
  if (!pending || pending.state !== state) {
    return refuse(request, config.issuer, "This single sign-on request could not be verified. Start again.");
  }

  const client = new HttpOidcClient();
  let payload: Record<string, unknown>;
  try {
    const token = await client.exchangeCode({
      discovery: await client.discover(config.issuer),
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: ssoRedirectUri(originOf(request)),
      codeVerifier: pending.codeVerifier,
    });
    payload = token.payload;
  } catch (error) {
    return refuse(
      request,
      config.issuer,
      error instanceof Error ? error.message : "Could not complete single sign-on.",
    );
  }

  const claims = extractOidcClaims(payload, { issuer: config.issuer, nonce: pending.nonce });
  if (!claims.ok) return refuse(request, config.issuer, claims.reason);

  const authorized = authorizeSso(config, claims.claims);
  if (!authorized.ok) return refuse(request, config.issuer, authorized.reason);

  const signedIn = await resolveSsoSignIn(prismaSsoStore, authorized.authorization);
  if (!signedIn.ok) return refuse(request, config.issuer, signedIn.error);

  const { user } = signedIn.value;
  await recordAudit(ssoSignInAudit(authorized.authorization, signedIn.value, config.issuer));

  await createSession({ id: user.id, email: user.email, name: user.name, role: user.role, accent: user.accent });

  return NextResponse.redirect(new URL(pending.returnTo || ROLE_HOME[user.role], originOf(request)));
}
