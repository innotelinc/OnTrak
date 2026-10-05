/**
 * `GET /api/v1/results/export` — the same page of results as a CSV file.
 *
 * Same filters as `/api/v1/results`, one page per request rather than a whole
 * table in memory: a deployment with a year of attempts behind it should not be
 * able to make the process allocate all of it because somebody clicked export.
 * A caller that wants everything follows `nextCursor` the same way it would on
 * the JSON feed and concatenates the pages; the header row is emitted every
 * time so each page is a file that opens on its own.
 *
 *   GET /api/v1/results/export?cohortId=...&limit=500
 *   Authorization: Bearer $ONTRAK_API_TOKEN
 */

import { NextResponse, type NextRequest } from "next/server";

import { csvFileName, resultsCsv } from "@/lib/csv-rules";

import { apiAccess } from "../../_access";
import { loadResultPage, readResultFilters, toCsvRow } from "../../_results";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  const access = apiAccess(request);
  if (!access.ok) return access.response;

  const read = readResultFilters(new URL(request.url));
  if (!read.ok) {
    return NextResponse.json({ error: read.reason }, { status: 400 });
  }

  const { rows, nextCursor } = await loadResultPage(read.filters);

  return new Response(resultsCsv(rows.map(toCsvRow)), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${csvFileName("ontrak-results")}"`,
      // A header, because a page of CSV has no room for one and a caller that
      // pages must know whether the file it just received is the last one.
      "x-ontrak-next-cursor": nextCursor ?? "",
    },
  });
}
