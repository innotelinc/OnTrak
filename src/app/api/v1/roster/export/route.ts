/**
 * `GET /api/v1/roster/export` — the roster as a CSV file.
 *
 * The same filters and paging as `/api/v1/roster`, and one page per request, so
 * the file an administrator opens is the file they can hand straight back to
 * `POST /api/v1/roster`: the columns are the ones the importer reads, in the
 * order it expects, and the two share one header list meanwhile.
 *
 *   GET /api/v1/roster/export?cohortId=...&role=STUDENT
 *   Authorization: Bearer $ONTRAK_API_TOKEN
 */

import { NextResponse, type NextRequest } from "next/server";

import { csvFileName, rosterCsv } from "@/lib/csv-rules";
import { loadRosterPage, readRosterFilters, toRosterCsvRow } from "../../_roster";
import { apiAccess } from "../../_access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  const access = apiAccess(request);
  if (!access.ok) return access.response;

  const read = readRosterFilters(request.nextUrl.searchParams);
  if (!read.ok) return NextResponse.json({ error: read.reason }, { status: 400 });

  const { rows, localPassword, nextCursor } = await loadRosterPage(read.filters);
  const csv = rosterCsv(rows.map((user) => toRosterCsvRow(user, localPassword.has(user.id))));

  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${csvFileName("ontrak-roster")}"`,
      "x-ontrak-next-cursor": nextCursor ?? "",
    },
  });
}
