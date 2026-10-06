/**
 * LTI login initiation.
 *
 * The platform posts here from a link or an iframe, naming itself, the person it
 * has already authenticated and where it wants them to land. This route does the
 * three things LTI 1.3 asks of a tool at this step:
 *
 *   1. **refuses anything that is not this deployment's platform** — a login
 *      naming another issuer is somebody else's launch, and there is no useful way
 *      to answer it;
 *   2. **starts a round trip** with a `state` and a `nonce` in a signed cookie, so
 *      the launch that comes back can be shown to be the one we asked for;
 *   3. **redirects the browser to the platform's authorization endpoint** with
 *      `response_mode=form_post`, which is how the assertion arrives at
 *      `/api/lti/launch`.
 *
 * The redirect is a **303**: the platform's endpoint is a `GET`, and a 307 would
 * replay this POST at somebody else's server.
 *
 * Nothing here is a decision — every check is `readLtiLogin` and every URL is
 * `buildLtiLoginUrl`, so this file is only the wiring.
 */

import { NextResponse, type NextRequest } from "next/server";

import { safeRelativePath } from "../../../../lib/auth-rules";
import { randomUrlSafe } from "../../../../lib/oidc-client";
import { deploymentOrigin } from "../../../../lib/oidc-rules";
import {
  activeLtiConfig,
  buildLtiLoginUrl,
  ltiConfigIssues,
  ltiRedirectUri,
  readLtiLogin,
} from "../../../../lib/lti-rules";
import { setLtiState } from "../../../../lib/lti-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function originOf(request: NextRequest): string {
  return deploymentOrigin(process.env.ONTRAK_TRAINING_BASE_URL, request.nextUrl.origin);
}

/**
 * The parameters, from the form body *and* the query string.
 *
 * The specification says POST, and a platform that puts them in the query string
 * instead is common enough that refusing it would be pedantry rather than
 * security: both are read, and every check below is the same either way.
 */
async function paramsOf(request: NextRequest): Promise<URLSearchParams> {
  const params = new URLSearchParams(request.nextUrl.searchParams);
  if (request.method === "POST") {
    try {
      const form = await request.formData();
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") params.set(key, value);
      }
    } catch {
      // A body that is not a form is not a reason to fail: the query string may
      // still carry everything, and if it does not, the check below says so.
    }
  }
  return params;
}

async function login(request: NextRequest): Promise<NextResponse> {
  const config = activeLtiConfig();
  if (!config) {
    const issues = ltiConfigIssues();
    return NextResponse.json(
      { error: issues[0] ?? "This deployment does not have a learning platform configured." },
      { status: 503 },
    );
  }

  const params = await paramsOf(request);
  const read = readLtiLogin(params, config);
  if (!read.ok) return NextResponse.json({ error: read.reason }, { status: 400 });

  const origin = originOf(request);
  const state = randomUrlSafe(24);
  const nonce = randomUrlSafe(24);

  // Where the person ends up after the launch. Only a same-site path survives, so
  // a crafted `target_link_uri` cannot turn the launch into an open redirect —
  // and when the platform named none, the launch lands them at their own home.
  const returnTo = safeRelativePath(params.get("target_link_uri")) ?? "";

  await setLtiState({ state, nonce, returnTo, at: new Date().toISOString() });

  return NextResponse.redirect(
    buildLtiLoginUrl(config, {
      loginHint: read.request.loginHint,
      targetLinkUri: read.request.targetLinkUri ?? ltiRedirectUri(origin),
      messageHint: read.request.messageHint,
      state,
      nonce,
      redirectUri: ltiRedirectUri(origin),
    }),
    303,
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return login(request);
}

/** Some platforms open the link as a GET before deciding to POST. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return login(request);
}
