/**
 * Assurance Packet verification endpoint (M3).
 *
 * `POST /api/verify/packet` is the *receiver's* side of the export, and it is
 * deliberately unauthenticated: an auditor, an insurer or a client holding a
 * packet and the key must be able to check it without an account, a tenant or a
 * session. There is nothing to authorize — the key is supplied by the caller and
 * nothing is read from or written to the database.
 *
 * The tool that most third parties will actually use is
 * `scripts/verify-packet.ts` (offline, no server). This route exists so the same
 * check is available from a browser, and so the verification logic has exactly
 * one implementation rather than two.
 *
 *   curl -s localhost:3001/api/verify/packet \
 *     -H 'content-type: application/json' \
 *     -d "{\"key\":\"$ONTRAK_TIX_ASSURANCE_SECRET\",\"packet\":$(cat packet.json)}"
 */

import { NextResponse, type NextRequest } from "next/server";

import { verifyPacketJson, verifyPacketObject } from "../../../../lib/assurance-verify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Send JSON: { packet, key }." }, { status: 400 });
  }

  const { packet, key } = body as { packet?: unknown; key?: unknown };
  if (typeof key !== "string" || key.trim() === "") {
    return NextResponse.json(
      { error: "A key is required. Verification is an HMAC check, so the packet cannot be checked without it." },
      { status: 400 },
    );
  }
  if (packet === undefined) {
    return NextResponse.json({ error: "Send the packet to verify." }, { status: 400 });
  }

  const outcome =
    typeof packet === "string" ? verifyPacketJson(packet, key) : verifyPacketObject(packet, key);

  // A packet that fails still returns 200: "this document is not valid" is the
  // *answer*, not a transport error, and a reviewer needs the report either way.
  return NextResponse.json(outcome);
}
