/**
 * LTI launch.
 *
 * The platform posts the assertion here, as `form_post`, at the redirect URI it
 * registered. The route:
 *
 *   1. recovers the signed launch state (`state`, `nonce`) and refuses anything
 *      that does not match — this is the check that makes the launch *ours*;
 *   2. verifies the assertion's signature against the platform's published keys,
 *      and its issuer and audience against the registration;
 *   3. reads the claims into what this product understands, or refuses with a
 *      sentence an operator can act on;
 *   4. finds or provisions the account and signs the person in;
 *   5. **keeps the grading context** — the line item, the subject, the course — in
 *      a short-lived cookie, so the attempt they then start carries it and the
 *      score can be written back. See `src/lib/lti-grade.ts`.
 *
 * A refusal is JSON rather than a redirect to the sign-in page, and that is
 * deliberate: this request begins inside somebody else's frame, so sending the
 * browser to a login form would be showing this product's front door in a window
 * the platform controls. The reason is returned instead, for the platform to
 * show.
 */

import { NextResponse, type NextRequest } from "next/server";

import { recordAudit } from "../../../../lib/audit";
import { createSession, ROLE_HOME } from "../../../../lib/auth";
import { HttpLtiClient } from "../../../../lib/lti-client";
import {
  activeLtiConfig,
  extractLaunchClaims,
  ltiConfigIssues,
  ltiLaunchFacts,
  ltiStateExpired,
} from "../../../../lib/lti-rules";
import { launchAuthorization, ltiDeniedAudit, ltiLaunchAudit } from "../../../../lib/lti-service";
import { clearLtiState, readLtiState, setLtiLaunch } from "../../../../lib/lti-session";
import { resolveSsoSignIn } from "../../../../lib/oidc-service";
import { prismaSsoStore } from "../../../../lib/oidc-store-prisma";
import { deploymentOrigin } from "../../../../lib/oidc-rules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function originOf(request: NextRequest): string {
  return deploymentOrigin(process.env.ONTRAK_TRAINING_BASE_URL, request.nextUrl.origin);
}

async function refuse(request: NextRequest, platform: string, reason: string, status = 400): Promise<NextResponse> {
  await recordAudit(ltiDeniedAudit(platform, reason));
  return NextResponse.json({ error: reason }, { status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = activeLtiConfig();
  if (!config) {
    const issues = ltiConfigIssues();
    return NextResponse.json(
      { error: issues[0] ?? "This deployment does not have a learning platform configured." },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return refuse(request, config.issuer, "The launch carried no form body.");
  }

  const idToken = typeof form.get("id_token") === "string" ? String(form.get("id_token")) : "";
  const presented = typeof form.get("state") === "string" ? String(form.get("state")) : "";
  if (!idToken) return refuse(request, config.issuer, "The launch carried no assertion.");

  const pending = await readLtiState();
  await clearLtiState();
  if (!pending || (presented && pending.state !== presented)) {
    return refuse(request, config.issuer, "This launch did not match the request this deployment started.");
  }
  if (ltiStateExpired(pending, new Date().toISOString())) {
    return refuse(request, config.issuer, "This launch took too long to come back. Start it again from the platform.");
  }

  let payload: Record<string, unknown>;
  try {
    payload = await new HttpLtiClient().verifyLaunch({
      idToken,
      issuer: config.issuer,
      clientId: config.clientId,
      jwksUri: config.jwksUri,
    });
  } catch (error) {
    return refuse(
      request,
      config.issuer,
      error instanceof Error ? `The launch assertion could not be verified: ${error.message}` : "The launch assertion could not be verified.",
    );
  }

  const extracted = extractLaunchClaims(payload, {
    issuer: config.issuer,
    clientId: config.clientId,
    nonce: pending.nonce,
    deploymentIds: config.deploymentIds,
    defaultRole: config.defaultRole,
  });
  if (!extracted.ok) return refuse(request, config.issuer, extracted.reason);

  const { launch } = extracted;
  const signedIn = await resolveSsoSignIn(prismaSsoStore, launchAuthorization(launch));
  if (!signedIn.ok) return refuse(request, config.issuer, signedIn.error, 403);

  await recordAudit(ltiLaunchAudit(launch, signedIn.value));

  // The grading context travels with the browser rather than with the session: a
  // launch says where a score goes, and the attempt started from it inherits that
  // and nothing else.
  await setLtiLaunch(ltiLaunchFacts(launch, new Date().toISOString()));

  const { user } = signedIn.value;
  await createSession({ id: user.id, email: user.email, name: user.name, role: user.role, accent: user.accent });

  return NextResponse.redirect(new URL(pending.returnTo || ROLE_HOME[user.role], originOf(request)), 303);
}
