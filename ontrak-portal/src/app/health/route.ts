/**
 * Liveness for the family's own checks.
 *
 * The portal probes every product at `/health`, and it should answer the same
 * question itself: unauthenticated, no database, only that the process is up and
 * routing. The dashboard's own redirect-to-sign-in lives on the pages, not here.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json(
    { status: "ok", service: "ontrak-portal" },
    { headers: { "cache-control": "no-store" } },
  );
}
