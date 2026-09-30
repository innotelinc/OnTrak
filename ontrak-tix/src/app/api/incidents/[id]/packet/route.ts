/**
 * Assurance Packet export (M3).
 *
 * `GET /api/incidents/<id>/packet` is the one-click export the roadmap calls for:
 * a signed, self-contained document holding the incident's facts and lifecycle,
 * its playbook and what happened to each step, its evidence manifest with every
 * item's digest, its chain of custody and any legal hold, its append-only
 * timeline, an excerpt of the tenant's hash-chained audit log with the chain head
 * it was read at, and the policy versions in force.
 *
 * Two things make it more than a JSON dump:
 *
 *  - `recordHash` is a stable fingerprint of the incident *record*, so an
 *    archived packet can be compared against a fresh one and shown to be the
 *    same evidence;
 *  - `contentHash` digests the whole packet, audit anchor included, and
 *    `signature` is an HMAC over it — so the packet proves its own integrity to
 *    a reader who has nothing but the file, and nothing in it can be edited
 *    without the deployment's key;
 *  - exporting *is* an audited act. The service writes an
 *    `incident.packet.export` event carrying the digest, so the chain records
 *    that this packet was produced and what it committed to.
 *
 * Staff-only, scoped to the caller's tenant by the service.
 */

import { NextResponse, type NextRequest } from "next/server";

import { actorHasPermission } from "../../../../../lib/access-rules";
import { assuranceServicesFor } from "../../../../../lib/db";
import { requireActor } from "../../../../../lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const actor = await requireActor();
  if (!actorHasPermission(actor, "ticket:read:any")) {
    return NextResponse.json({ error: "You do not have access to incidents." }, { status: 403 });
  }

  const { id } = await params;
  const result = await assuranceServicesFor().packet(actor, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });

  const packet = result.value;
  return new NextResponse(JSON.stringify(packet, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${packet.incident.ref}-assurance-packet.json"`,
      // The digest and signature are headers too, so a client can pin them
      // without parsing the body.
      "x-packet-hash": packet.contentHash,
      "x-packet-record-hash": packet.recordHash,
      "x-packet-signature": packet.signature,
      "x-packet-algorithm": packet.algorithm,
    },
  });
}
