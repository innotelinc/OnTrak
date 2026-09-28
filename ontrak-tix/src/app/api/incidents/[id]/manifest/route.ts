/**
 * Incident evidence manifest (M3).
 *
 * `GET /api/incidents/<id>/manifest` returns the incident's manifest as JSON: its
 * severity and lifecycle facts, its playbook plan and step outcomes, every
 * evidence item with its own digest, the append-only timeline, and a
 * `manifestHash` that commits to all of it.
 *
 * Producing a manifest is *deliberately recorded* — the service writes an
 * `incident.manifest` audit event carrying the digest. That is a read which
 * legitimately leaves a trace: "this manifest existed, with this hash, at this
 * moment" is itself the evidence someone may later need to cite.
 *
 * Staff-only, and scoped to the caller's tenant by the service.
 */

import { NextResponse, type NextRequest } from "next/server";

import { hasPermission } from "../../../../../lib/access-rules";
import { incidentDocsServicesFor } from "../../../../../lib/db";
import { requireActor } from "../../../../../lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const actor = await requireActor();
  if (!hasPermission(actor.role, "ticket:read:any")) {
    return NextResponse.json({ error: "You do not have access to incidents." }, { status: 403 });
  }

  const { id } = await params;
  const result = await incidentDocsServicesFor().manifest(actor.tenantId, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });

  const manifest = result.value;
  return new NextResponse(JSON.stringify(manifest, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${manifest.incident.ref}-manifest.json"`,
      // The digest is also an HTTP header, so a client can compare it cheaply.
      "x-manifest-hash": manifest.manifestHash,
    },
  });
}
