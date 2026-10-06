/**
 * One class, by this deployment's id.
 *
 *   GET    /api/scim/v2/Groups/{id}
 *   PATCH  /api/scim/v2/Groups/{id}   replace the class's members with the list it names
 *   DELETE /api/scim/v2/Groups/{id}   refused — a class holds its members' attempts
 *
 * A group PATCH is a **replacement**, because that is what a directory's Push Groups
 * sends: the complete list of who is in the group. A rename is refused: the class's
 * name and join code are its instructor's, and a name change over SCIM would silently
 * invalidate every code a learner was handed.
 */

import type { NextRequest } from "next/server";

import { scimError } from "@/lib/scim-rules";
import { methodNotAllowed, scimAccess, scimBody, scimFailure, scimJson, scimServiceFor } from "../../_scim";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Context): Promise<Response> {
  const access = scimAccess(request);
  if (!access.ok) return access.response;

  const { id } = await params;
  const result = await scimServiceFor(request).getGroup(id);
  return result.ok ? scimJson(200, result.value) : scimFailure(result.error);
}

export async function PATCH(request: NextRequest, { params }: Context): Promise<Response> {
  const access = scimAccess(request);
  if (!access.ok) return access.response;

  const { id } = await params;
  const body = await scimBody(request);
  if (body === null) return scimFailure(scimError(400, "A PATCH body is required.", "invalidSyntax"));

  const result = await scimServiceFor(request).patchGroup(id, body);
  return result.ok ? scimJson(200, result.value) : scimFailure(result.error);
}

export async function DELETE(request: NextRequest, { params }: Context): Promise<Response> {
  const access = scimAccess(request);
  if (!access.ok) return access.response;

  const { id } = await params;
  const result = await scimServiceFor(request).deleteGroup(id);
  if (!result.ok) return scimFailure(result.error);
  return new Response("", { status: 204, headers: { "cache-control": "no-store" } });
}

export async function POST(): Promise<Response> {
  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}
