/**
 * `GET /api/v1/scenarios/<id>/export` — one scenario as a portable bundle.
 *
 * Staff only, and read as the signed-in person rather than as the API token:
 * a bundle contains a graded artifact's checks, and the catalog is shared staff
 * material, not a public endpoint. The response is a download (`Content-Disposition`)
 * so a browser saves it instead of rendering a wall of JSON.
 *
 * The row's identity stays here: `exportScenarioBundle` deliberately omits the id,
 * slug, author and publish flag, because those are facts about this deployment
 * rather than about the exercise.
 */

import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { bundleFilename, exportScenarioBundle } from "@/lib/scenario-bundle";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context): Promise<NextResponse> {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (user.role !== "ADMIN" && user.role !== "INSTRUCTOR") {
    return NextResponse.json({ error: "Instructor access is required for that." }, { status: 403 });
  }

  const { id } = await params;
  const scenario = await prisma.scenario.findUnique({ where: { id } });
  if (!scenario) return NextResponse.json({ error: "That scenario no longer exists." }, { status: 404 });

  const bundle = exportScenarioBundle(scenario);
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${bundleFilename(scenario.title)}"`,
      "cache-control": "no-store",
    },
  });
}
