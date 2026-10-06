/**
 * The guard and the wiring the SCIM routes share.
 *
 * Files under a leading `_` are private to the App Router, so this is not a route:
 * it is the access check, the error body and the service construction every SCIM
 * endpoint uses.
 *
 * The token is one shared secret per deployment, presented as a bearer token and
 * compared length-independently by the same helper the public API and the desk's
 * intake endpoint use. Unconfigured is a **503 with a reason** and not a 401, for the
 * same reason the public API says so: "nobody set a token" and "your token is wrong"
 * are different problems for the person reading a failed sync's output, and only one
 * of them is theirs to fix.
 */

import { NextResponse, type NextRequest } from "next/server";

import { recordAudit } from "@/lib/audit";
import { bearerToken, serviceTokenMatches } from "@/lib/its-intake-rules";
import { deploymentOrigin } from "@/lib/oidc-rules";
import { SCIM_CONTENT_TYPE, SCIM_ERROR_SCHEMA, type ScimError } from "@/lib/scim-rules";
import { ScimService } from "@/lib/scim-service";
import { prismaScimStore } from "@/lib/scim-store-prisma";

export const SCIM_TOKEN_ENV = "ONTRAK_SCIM_TOKEN";

export type ScimAccess = { ok: true } | { ok: false; response: NextResponse };

export function scimAccess(request: NextRequest): ScimAccess {
  const expected = (process.env[SCIM_TOKEN_ENV] ?? "").trim();
  if (!expected) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `This deployment has no ${SCIM_TOKEN_ENV} set, so directory sync is closed.` },
        { status: 503 },
      ),
    };
  }
  if (!serviceTokenMatches(bearerToken(request.headers.get("authorization")), expected)) {
    const response = NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    response.headers.set("www-authenticate", "Bearer");
    return { ok: false, response };
  }
  return { ok: true };
}

/** A SCIM response: the media type RFC 7644 asks for, and no caching. */
export function scimJson(status: number, body: unknown, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "content-type": SCIM_CONTENT_TYPE, "cache-control": "no-store", ...headers },
  });
}

/** A refusal in the shape RFC 7644 §3.12 defines, because a connector parses it. */
export function scimFailure(error: ScimError): NextResponse {
  return scimJson(error.status, {
    schemas: [SCIM_ERROR_SCHEMA],
    detail: error.detail,
    status: String(error.status),
    ...(error.scimType ? { scimType: error.scimType } : {}),
  });
}

/** The JSON body, or `null` when the request carried none or it did not parse. */
export async function scimBody(request: NextRequest): Promise<unknown | null> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}

export function methodNotAllowed(allowed: readonly string[]): NextResponse {
  return scimJson(
    405,
    { schemas: [SCIM_ERROR_SCHEMA], detail: `Use ${allowed.join(" or ")}.`, status: "405" },
    { allow: allowed.join(", ") },
  );
}

/**
 * The service, bound to this deployment's address.
 *
 * The base URL is what `meta.location` links are built from, and it is stated by the
 * deployment (`ONTRAK_TRAINING_BASE_URL`) rather than guessed at the socket, so a
 * link a connector was handed keeps resolving behind a proxy.
 */
export function scimServiceFor(request: NextRequest): ScimService {
  const base = deploymentOrigin(process.env.ONTRAK_TRAINING_BASE_URL, request.nextUrl.origin);
  return new ScimService(prismaScimStore, base, (event) => recordAudit(event));
}
