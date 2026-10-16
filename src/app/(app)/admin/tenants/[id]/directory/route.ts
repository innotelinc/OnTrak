/**
 * `GET /admin/tenants/[id]/directory` — one tenancy's course listings as a CSV file.
 *
 * This is the file a provider hands over when it submits or updates its course details for the
 * funder's directory (§4.3, §4.4): the course details §3.3 asks for, the provider's own contact
 * information, and where each course stands — drafted, published, or taken down again.
 *
 * Scoped to the tenancy in the path, with the same permission the page uses: a listing export
 * that answered for somebody else's catalogue would be the point of tenancies defeated by a URL.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { canAdministerTenant } from "@/lib/tenancy";
import { csvFileName } from "@/lib/csv-rules";
import { directoryCsv, directoryEntries } from "@/lib/directory-rules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  let viewer;
  try {
    viewer = await requireSession();
  } catch {
    return NextResponse.json({ error: "Sign in to export the directory." }, { status: 401 });
  }
  if (!canAdministerTenant(viewer, id)) {
    return NextResponse.json({ error: "That tenancy is not one you administer." }, { status: 403 });
  }

  const tenant = await prisma.organization.findUnique({
    where: { id },
    include: {
      courses: {
        // The provider's own numbering, which is how the funder's paperwork refers to a course.
        orderBy: [{ courseNumber: "asc" }, { title: "asc" }],
        include: { program: { select: { name: true, funder: true } } },
      },
    },
  });
  if (!tenant) return NextResponse.json({ error: "No such tenancy." }, { status: 404 });

  const entries = directoryEntries({ organization: tenant, courses: tenant.courses });

  return new Response(directoryCsv(entries), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${csvFileName(`${tenant.slug}-directory`)}"`,
      // The row count is not in the file's own header row, and a provider checking the export
      // against its catalogue should not have to count lines to do it.
      "x-ontrak-listings": String(entries.length),
    },
  });
}
