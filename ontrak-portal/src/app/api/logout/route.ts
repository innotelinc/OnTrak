import { NextResponse } from "next/server";

/**
 * Sign out.
 *
 * Clears this portal's cookie and nothing else. The portal session is only a
 * routing hint — each product behind a tile holds its own credential — so
 * pretending to sign somebody out of four applications from here would be a
 * promise this route cannot keep. The page says so instead, and links to each
 * product's own sign-out.
 */

import { clearSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  await clearSession();
  return NextResponse.json({ signed_out: true });
}
