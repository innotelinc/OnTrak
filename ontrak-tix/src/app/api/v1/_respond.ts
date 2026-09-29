/**
 * The two lines every `/api/v1` route needs.
 *
 * `send` is the whole adapter between the pure HTTP layer (`public-api-http.ts`)
 * and Next: the layer decides status, headers and body, and this writes them. No
 * route does any of that itself, so no route can forget `no-store` or invent a
 * status code.
 *
 * `staffActor` is the *session* guard, used only by the token-administration
 * endpoints. An API token cannot mint another API token: that would let a
 * credential that has leaked once re-issue itself after being revoked, which
 * removes the one remedy revocation exists to provide. Minting is therefore a
 * signed-in administrator's act, and it starts from `requireActor()` like every
 * other privileged write in the product.
 */

import { NextResponse } from "next/server";

import type { Actor } from "../../../lib/access-rules";
import type { ApiResponse } from "../../../lib/public-api-http";
import { requireActor } from "../../../lib/session";

/** Turn a pure-layer response into the framework's. */
export function send(response: ApiResponse): NextResponse {
  return new NextResponse(response.body, { status: response.status, headers: response.headers });
}

/** The signed-in caller, or `null` when the request has no usable session. */
export async function staffActor(): Promise<Actor | null> {
  try {
    return await requireActor();
  } catch {
    // `requireActor()` redirects when there is no session, which is right for a
    // page and wrong for an API: a JSON caller gets a `401` body, not an HTML
    // redirect it cannot follow.
    return null;
  }
}
