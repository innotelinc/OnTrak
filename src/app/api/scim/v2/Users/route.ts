/**
 * `GET /api/scim/v2/Users` — who exists, as a directory reads it.
 * `POST /api/scim/v2/Users` — a directory making somebody exist.
 *
 *   GET  /api/scim/v2/Users?filter=userName eq "ada@acme.test"&startIndex=1&count=100
 *   POST /api/scim/v2/Users      { "userName": "…", "name": { "formatted": "…" }, … }
 *   Authorization: Bearer $ONTRAK_SCIM_TOKEN
 *
 * The filter subset is `eq` on `userName`, `externalId`, `displayName` or `id`, and
 * anything else is refused by name rather than silently ignored — a parser that drops
 * a clause answers a narrower question while looking like a success, which is how a
 * directory ends up quietly missing people.
 *
 * A user created here has **no local password**, exactly like one provisioned by the
 * identity provider: the directory says who exists, not what their secret is.
 */

import type { NextRequest } from "next/server";

import { scimError } from "@/lib/scim-rules";
import { methodNotAllowed, scimAccess, scimBody, scimFailure, scimJson, scimServiceFor } from "../_scim";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  const access = scimAccess(request);
  if (!access.ok) return access.response;

  const result = await scimServiceFor(request).listUsers(request.nextUrl.searchParams);
  return result.ok ? scimJson(200, result.value) : scimFailure(result.error);
}

export async function POST(request: NextRequest): Promise<Response> {
  const access = scimAccess(request);
  if (!access.ok) return access.response;

  const body = await scimBody(request);
  if (body === null) return scimFailure(scimError(400, "A user must be a JSON body.", "invalidSyntax"));

  const result = await scimServiceFor(request).createUser(body);
  if (!result.ok) return scimFailure(result.error);
  // `201` with the resource's own `Location`, which a connector stores and uses to
  // update the user later — getting it wrong means the next write goes elsewhere.
  return scimJson(201, result.value, { location: result.value.meta.location });
}

export async function PUT(): Promise<Response> {
  return methodNotAllowed(["GET", "POST"]);
}

export async function PATCH(): Promise<Response> {
  return methodNotAllowed(["GET", "POST"]);
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed(["GET", "POST"]);
}
