/**
 * `GET /api/v1/results` — what was graded, for a system outside this deployment.
 *
 * The webhook is a push and can be missed by a consumer that was down; this is
 * the pull that lets it catch up. They share the same row shape on purpose, so a
 * consumer writes one parser and the webhook's `data` and this route's `results[]`
 * are the same object.
 *
 *   GET /api/v1/results?since=2026-10-01T00:00:00Z&cohortId=...&limit=200
 *   Authorization: Bearer $ONTRAK_API_TOKEN
 *
 * `nextCursor` is returned whenever the page was full: the caller passes it back
 * as `cursor` to continue. It is null on the last page, so a loop that follows it
 * terminates without having to guess from the row count.
 */

import { NextResponse, type NextRequest } from "next/server";

import { apiAccess } from "../_access";
import { loadResultPage, readResultFilters, toResultJson } from "../_results";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = apiAccess(request);
  if (!access.ok) return access.response;

  const read = readResultFilters(request.nextUrl);
  if (!read.ok) return NextResponse.json({ error: read.reason }, { status: 400 });

  const { rows, nextCursor } = await loadResultPage(read.filters);
  return NextResponse.json({
    results: rows.map(toResultJson),
    nextCursor,
    count: rows.length,
  });
}
