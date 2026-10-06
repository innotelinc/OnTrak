/**
 * The tool's public key set — `GET /api/lti/jwks.json`.
 *
 * An LMS that offers "Public key type: Keyset URL" points at this instead of being
 * handed a copy of a PEM, and that is the arrangement worth preferring: the
 * deployment publishes the key it actually signs with, so the two sides cannot
 * drift apart (Moodle's sibling field is "RSA key", which takes the paste — see
 * `docs/moodle-lti.md` for both).
 *
 * It answers to the same rule as every other `/api/lti/*` route: **no usable
 * registration is a `503` naming the first thing that is wrong**, not a `404` and
 * not an empty key set. The platform logs the body, so an operator reading it learns
 * which variable to fix rather than that "the key set was empty".
 *
 * Two cases are worth separating, though they share the status. A deployment with no
 * platform registered has nothing to publish because it is not a tool here at all.
 * A deployment with a registration but no `ONTRAK_LTI_PRIVATE_KEY` is a tool that
 * launches and cannot pass a grade back — this route is where that shows up, since it
 * is the route that exists only for the passback.
 *
 * A key set is public by construction, so there is no authorization here, and the
 * response is cacheable. An hour is long enough that a busy platform is not
 * re-fetching on every passback, and short enough that a rotation under the same key
 * id is picked up without anybody restarting somebody else's server.
 */

import { NextResponse } from "next/server";

import { toolJwks } from "../../../../lib/lti-keys";
import { activeLtiConfig, ltiConfigIssues } from "../../../../lib/lti-rules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const config = activeLtiConfig();
  if (!config) {
    const issues = ltiConfigIssues();
    return NextResponse.json(
      { error: issues[0] ?? "This deployment does not have a learning platform configured." },
      { status: 503 },
    );
  }

  if (!config.privateKey || !config.keyId) {
    return NextResponse.json(
      {
        error:
          "This deployment has no LTI keypair, so there is no public key to publish. Run `make lti-key` and set ONTRAK_LTI_PRIVATE_KEY and ONTRAK_LTI_KEY_ID.",
      },
      { status: 503 },
    );
  }

  const jwks = toolJwks(config.privateKey, config.keyId);
  if (!jwks) {
    return NextResponse.json(
      { error: "ONTRAK_LTI_PRIVATE_KEY is not a PEM this deployment can read, so no public key can be published from it." },
      { status: 503 },
    );
  }

  return NextResponse.json(jwks, { headers: { "cache-control": "public, max-age=3600" } });
}
