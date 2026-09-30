/**
 * Liveness for the family portal's status light.
 *
 * Unauthenticated by design — the portal asks "are you there" without a
 * credential, and every member of the family answers on this one path. It reports
 * only that the dashboard process is up and routing; the API's own health is
 * `/api/health` on the backend, proxied by this origin, and is the richer answer.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json(
    { status: "ok", service: "ontrak-sync" },
    { headers: { "cache-control": "no-store" } },
  );
}
