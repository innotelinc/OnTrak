/**
 * Liveness for the family portal's status light.
 *
 * Unauthenticated by design — the portal asks "are you there" without a
 * credential, and every member of the family answers on this one path. It reports
 * only that the process is up and routing, not the database: a health check that
 * needs Postgres turns a slow query into an outage report the caller cannot fix.
 *
 * `/health` is deliberately outside the middleware's matcher, so the edge gate on
 * `/admin`, `/instructor`, `/student` and `/certificate` does not touch it.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json(
    { status: "ok", service: "ontrak-training" },
    { headers: { "cache-control": "no-store" } },
  );
}
