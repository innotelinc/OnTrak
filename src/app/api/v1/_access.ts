/**
 * Who may read this API.
 *
 * One shared secret per deployment, presented as a bearer token and compared
 * length-independently by the same helper the desk's intake endpoint uses. It is
 * deliberately *not* the session cookie: a caller here is a script or another
 * system, it has no browser and no user to be, and letting it in by session
 * would make every instructor's login an API credential.
 *
 * Unconfigured is a 503 with a reason and not a 401 — "nobody set a token" and
 * "your token is wrong" are different problems for the person reading a failed
 * sync's output, and only one of them is theirs to fix.
 *
 * Files under a leading `_` are private to the App Router, so this is not a
 * route: it is the guard the routes share.
 */

import { NextResponse, type NextRequest } from "next/server";

import { bearerToken, serviceTokenMatches } from "@/lib/its-intake-rules";

export const API_TOKEN_ENV = "ONTRAK_API_TOKEN";

export type ApiAccess = { ok: true } | { ok: false; response: NextResponse };

export function apiAccess(request: NextRequest): ApiAccess {
  const expected = (process.env[API_TOKEN_ENV] ?? "").trim();
  if (!expected) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `This deployment has no ${API_TOKEN_ENV} set, so the public API is closed.` },
        { status: 503 },
      ),
    };
  }
  if (!serviceTokenMatches(bearerToken(request.headers.get("authorization")), expected)) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) };
  }
  return { ok: true };
}

/** 400 when the request body could not be read as JSON at all. */
export function badBody(): NextResponse {
  return NextResponse.json({ error: "The body was not JSON." }, { status: 400 });
}
