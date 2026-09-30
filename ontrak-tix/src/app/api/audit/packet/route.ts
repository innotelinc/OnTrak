/**
 * Tenant audit-evidence export (M6).
 *
 * `GET /api/audit/packet` is the M6 exit criterion in one file: "audit evidence
 * exports on demand". M3's incident packet is one incident's slice of the trail,
 * attached to a ticket; this is the trail itself, tenant-wide, signed — the document
 * an auditor or an insurer is handed when the question is not "what happened to this
 * ticket" but "show me everything this desk did".
 *
 * It is deliberately the *same envelope* as the incident packet — same version, same
 * `HMAC-SHA256`, same `recordHash`/`contentHash`/`signature` discipline — so the
 * verifier that already checks one checks the other, and a reader does not have to
 * learn a second document format to read the second half of the same story.
 *
 * Three things are worth stating out loud:
 *
 *  - **A trail that does not verify still exports**, with `verified: false` inside the
 *    signed anchor. Refusing to hand over a broken chain would withhold the evidence
 *    at exactly the moment it is worth the most; the failure that must not happen — a
 *    break presented as sound — cannot, because the flag is under the signature.
 *  - **Every event's payload is left behind.** The packet carries each entry's seq,
 *    time, actor, action and record hash, and not the free-form `detail` a handler
 *    attached to it. An export that widened itself to whatever each event happened to
 *    carry is how a token, a note or a password reset lands in a document that leaves
 *    the building.
 *  - **Exporting is itself audited** (`audit.chain.export`, carrying the digest), so
 *    who took a copy and what it committed to is on the chain the copy describes.
 *
 * Gated on `audit:read`, not on `ticket:read:any`: reading this desk's tickets and
 * taking away the record of everything anybody did here are different questions, and
 * only one of them is administrative. Scoped to the caller's tenant by the service.
 */

import { NextResponse, type NextRequest } from "next/server";

import { hasPermission } from "../../../../lib/access-rules";
import { assuranceServicesFor } from "../../../../lib/db";
import { requireActor } from "../../../../lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const actor = await requireActor();
  if (!hasPermission(actor.role, "audit:read")) {
    return NextResponse.json({ error: "You do not have access to the audit trail." }, { status: 403 });
  }

  const result = await assuranceServicesFor().auditExport(actor);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  const packet = result.value;
  return new NextResponse(JSON.stringify(packet, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="audit-evidence-${packet.generatedAt.slice(0, 10)}.json"`,
      // The digests and the verdict are headers too, so a client can pin them, or
      // refuse a packet whose trail did not verify, without parsing the body.
      "x-packet-kind": packet.kind,
      "x-packet-hash": packet.contentHash,
      "x-packet-record-hash": packet.recordHash,
      "x-packet-signature": packet.signature,
      "x-packet-algorithm": packet.algorithm,
      "x-packet-chain-verified": String(packet.audit.verified),
      "x-packet-chain-length": String(packet.audit.length),
    },
  });
}
