/**
 * `GET /admin/tenants/[id]/report` — one tenancy's program figures as a CSV file.
 *
 * This is the file a provider attaches to the report it files with the funder on the contract's
 * schedule, so it says who paid for what: the tenancy, the program, the class, the sponsor, and
 * then one row per learner with their enrolment, attendance and completion.
 *
 * Scoped to the tenancy in the path, with the same permission the page uses — an export
 * that answered for a tenancy the caller cannot see would be the whole point of tenancies
 * defeated by a URL.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { canAdministerTenant } from "@/lib/tenancy";
import { csvFileName } from "@/lib/csv-rules";
import { reportCsv, reportRows } from "@/lib/program-report";

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
    return NextResponse.json({ error: "Sign in to export a report." }, { status: 401 });
  }
  if (!canAdministerTenant(viewer, id)) {
    return NextResponse.json({ error: "That tenancy is not one you administer." }, { status: 403 });
  }

  const tenant = await prisma.organization.findUnique({
    where: { id },
    include: {
      classes: {
        orderBy: [{ startsOn: "asc" }, { createdAt: "asc" }],
        include: {
          course: { select: { title: true } },
          program: { select: { name: true, funder: true } },
          sponsor: { select: { name: true } },
          enrollments: {
            orderBy: { enrolledAt: "asc" },
            include: {
              user: { select: { name: true, email: true } },
              attendances: { select: { status: true } },
            },
          },
        },
      },
    },
  });
  if (!tenant) return NextResponse.json({ error: "No such tenancy." }, { status: 404 });

  // The same builder the tenancy page totals with, so the file and the page cannot disagree
  // about what a provider has committed and what it will be paid.
  const rows = reportRows({ organization: tenant, classes: tenant.classes });

  return new Response(reportCsv(rows), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${csvFileName(`${tenant.slug}-report`)}"`,
      // The row count is not in the file's own header row, and an operator reconciling a
      // report against the page should not have to count lines to do it.
      "x-ontrak-rows": String(rows.length),
    },
  });
}
