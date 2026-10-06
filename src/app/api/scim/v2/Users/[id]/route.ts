/**
 * One person, by this deployment's id.
 *
 *   GET    /api/scim/v2/Users/{id}
 *   PUT    /api/scim/v2/Users/{id}   replace the resource (omitted `active` means active)
 *   PATCH  /api/scim/v2/Users/{id}   change named attributes (omitted `active` is untouched)
 *   DELETE /api/scim/v2/Users/{id}   deactivate — training evidence cannot be deleted
 *
 * `DELETE` answers `204` and the account still exists, switched off. The alternative
 * — really deleting it — would take the person's attempts, certificates and audit
 * trail with it, and the entire point of this product is that those cannot be deleted.
 * A connector that expects the user to vanish finds, on its next read, an inactive
 * user, which is exactly the truth.
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
  const result = await scimServiceFor(request).getUser(id);
  return result.ok ? scimJson(200, result.value) : scimFailure(result.error);
}

export async function PUT(request: NextRequest, { params }: Context): Promise<Response> {
  const access = scimAccess(request);
  if (!access.ok) return access.response;

  const { id } = await params;
  const body = await scimBody(request);
  if (body === null) return scimFailure(scimError(400, "A PUT body is required.", "invalidSyntax"));

  const result = await scimServiceFor(request).replaceUser(id, body);
  return result.ok ? scimJson(200, result.value) : scimFailure(result.error);
}

export async function PATCH(request: NextRequest, { params }: Context): Promise<Response> {
  const access = scimAccess(request);
  if (!access.ok) return access.response;

  const { id } = await params;
  const body = await scimBody(request);
  if (body === null) return scimFailure(scimError(400, "A PATCH body is required.", "invalidSyntax"));

  const result = await scimServiceFor(request).patchUser(id, body);
  return result.ok ? scimJson(200, result.value) : scimFailure(result.error);
}

export async function DELETE(request: NextRequest, { params }: Context): Promise<Response> {
  const access = scimAccess(request);
  if (!access.ok) return access.response;

  const { id } = await params;
  const result = await scimServiceFor(request).deleteUser(id);
  if (!result.ok) return scimFailure(result.error);
  return new Response("", { status: 204, headers: { "cache-control": "no-store" } });
}

export async function POST(): Promise<Response> {
  return methodNotAllowed(["GET", "PUT", "PATCH", "DELETE"]);
}
