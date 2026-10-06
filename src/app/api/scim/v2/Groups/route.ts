/**
 * `GET /api/scim/v2/Groups` — a class and who is in it, as a directory reads it.
 *
 * A cohort here is a *class*: owned by an instructor, with a join code a person
 * chose. This surface syncs a class's **members**; it does not create or delete the
 * class itself. `POST` is therefore refused with a reason rather than obeyed — a
 * `POST /Groups` naming a class nobody owns would create a class with no teacher,
 * which is the same rule the CSV roster applies to a cohort name it does not
 * recognise.
 */

import type { NextRequest } from "next/server";

import { scimError } from "@/lib/scim-rules";
import { methodNotAllowed, scimAccess, scimBody, scimFailure, scimJson, scimServiceFor } from "../_scim";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  const access = scimAccess(request);
  if (!access.ok) return access.response;

  const result = await scimServiceFor(request).listGroups(request.nextUrl.searchParams);
  return result.ok ? scimJson(200, result.value) : scimFailure(result.error);
}

export async function POST(request: NextRequest): Promise<Response> {
  const access = scimAccess(request);
  if (!access.ok) return access.response;

  const body = await scimBody(request);
  if (body === null) return scimFailure(scimError(400, "A group must be a JSON body.", "invalidSyntax"));

  const result = await scimServiceFor(request).createGroup(body);
  return result.ok ? scimJson(201, result.value, { location: result.value.meta.location }) : scimFailure(result.error);
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
