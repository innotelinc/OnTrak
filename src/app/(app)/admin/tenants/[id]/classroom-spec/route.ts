/**
 * `GET /admin/tenants/[id]/classroom-spec?courseId=…[&cohortId=…]` — the AI classroom
 * specification for one course, or for one class of it, as the JSON file AthenIQ expects.
 *
 * This is the artifact that crosses the seam between the two products. OnTrak holds the funded
 * class — the provider, the employer paying for the seats, the window, the price, and the
 * course as it was authored for the funder's directory — and AthenIQ holds the classroom:
 * `courses/<slug>/openmaic/classrooms.json` is where its specs live, and its own README says
 * what happens next ("submit prompt, objectives, and the defaults agent roles to OpenMAIC as
 * the lesson brief"). So this route emits exactly that document, generated from rows a
 * provider already maintains, and the provider downloads it, generates the classroom, and
 * pastes the classroom's address back into the course or the class it came from.
 *
 * One file per request rather than one per tenancy: a spec is per *course* (and per run, so a
 * second sitting is a second `source_course` and a second classroom), which is what makes a
 * downloaded file name unambiguous in a folder full of them.
 *
 * Scoped to the tenancy in the path, with the permission its pages use — an instructor who
 * teaches the class may have the spec for it, and nobody else in the estate may.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { canManageTenant } from "@/lib/tenancy";
import { classroomSpecFilename, classroomSpecJson } from "@/lib/classroom-rules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const url = new URL(request.url);
  const courseId = url.searchParams.get("courseId") ?? "";
  const cohortId = url.searchParams.get("cohortId") ?? "";

  let viewer;
  try {
    viewer = await requireSession();
  } catch {
    return NextResponse.json({ error: "Sign in to generate a classroom specification." }, { status: 401 });
  }
  if (!canManageTenant(viewer, id)) {
    return NextResponse.json({ error: "That tenancy is not one you teach in." }, { status: 403 });
  }

  const course = await prisma.course.findUnique({
    where: { id: courseId },
    include: {
      organization: { select: { name: true, slug: true } },
      program: { select: { startsOn: true } },
      modules: { orderBy: { position: "asc" } },
    },
  });
  if (!course || course.organizationId !== id) {
    return NextResponse.json({ error: "That course is not in this tenancy." }, { status: 404 });
  }

  // The class is optional: a course's classroom is generated once and shared, while a class's
  // is generated for its own sitting — which is why the class contributes the employer and the
  // date the run is named after.
  const klass = cohortId
    ? await prisma.cohort.findUnique({
        where: { id: cohortId },
        include: { sponsor: { select: { name: true } } },
      })
    : null;
  if (cohortId && (!klass || klass.organizationId !== id || klass.courseId !== course.id)) {
    return NextResponse.json({ error: "That class is not of this course." }, { status: 404 });
  }

  const body = classroomSpecJson({
    organizationSlug: course.organization.slug,
    providerName: course.organization.name,
    sponsorName: klass?.sponsor?.name ?? null,
    startsOn: klass?.startsOn ?? course.program?.startsOn ?? course.createdAt,
    course: {
      title: course.title,
      summary: course.summary,
      audience: course.audience,
      prerequisites: course.prerequisites,
      instructionalHours: course.instructionalHours,
      deliveryMode: course.deliveryMode,
    },
    modules: course.modules.map((module) => ({
      position: module.position,
      title: module.title,
      hours: module.hours,
      objectives: module.objectives,
      activity: module.activity,
      outcome: module.outcome,
    })),
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${classroomSpecFilename(course.title)}"`,
      // The page that links here prints the count, and a file whose name says one classroom
      // while its body holds four is worth being able to check without opening it.
      "x-ontrak-classrooms": String(course.modules.length),
    },
  });
}
