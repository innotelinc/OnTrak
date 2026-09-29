/**
 * Scenario drafts from the desk.
 *
 * `POST /api/v1/scenario-drafts` accepts one draft — the objectives and steps for a
 * practice scenario, written by OnTrak Tix when it resolved a ticket — and stores it
 * unpublished for an instructor to turn into a scenario.
 *
 *   POST /api/v1/scenario-drafts        Authorization: Bearer $ONTRAK_ITS_SERVICE_TOKEN
 *   GET  /api/v1/scenario-drafts        the queue, newest first
 *
 * IDEMPOTENT BY `sourceRef`. The desk's sweep checks the ticket before it sends, but
 * a sweep can be interrupted between the two, so a second POST for the same ticket
 * updates the draft it already has and answers 200 instead of creating a duplicate.
 * That is what makes it safe to run on a schedule and to retry by hand.
 *
 * Unconfigured is a 503 with a reason, not a 401: "nobody set the token" and "your
 * token is wrong" are different problems for the person reading the sweep report.
 */

import { NextResponse, type NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";

import { prisma } from "../../../../lib/db";
import { readScenarioDraft, bearerToken, serviceTokenMatches, ITS_SERVICE_TOKEN_ENV } from "../../../../lib/its-intake-rules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function authorised(request: NextRequest): { ok: true } | { ok: false; response: NextResponse } {
  const expected = (process.env[ITS_SERVICE_TOKEN_ENV] ?? "").trim();
  if (!expected) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `This range has no ${ITS_SERVICE_TOKEN_ENV} set, so it cannot accept drafts.` },
        { status: 503 },
      ),
    };
  }
  if (!serviceTokenMatches(bearerToken(request.headers.get("authorization")), expected)) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) };
  }
  return { ok: true };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = authorised(request);
  if (!access.ok) return access.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "The body was not JSON." }, { status: 400 });
  }

  const parsed = readScenarioDraft(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.reason }, { status: 422 });
  const draft = parsed.value;

  const data = {
    sourceRef: draft.sourceRef,
    source: draft.source,
    title: draft.title,
    summary: draft.summary,
    description: draft.description,
    engine: draft.engine,
    difficulty: draft.difficulty,
    objectives: draft.objectives,
    // `ItsStep` is a described shape, which is what a reader wants; Prisma's JSON
    // input type wants an index signature. Validated by `readScenarioDraft` just
    // above, so the cast is about the type system, not about trust.
    steps: draft.steps as unknown as Prisma.InputJsonValue,
    tags: draft.tags,
  };

  // `upsert` rather than `create`: the unique `sourceRef` is the idempotency key, and
  // an upsert expresses "one draft per ticket" without a read-then-write race between
  // two sweeps running at once.
  const existing = await prisma.scenarioDraft.findUnique({ where: { sourceRef: draft.sourceRef } });
  const record = await prisma.scenarioDraft.upsert({
    where: { sourceRef: draft.sourceRef },
    create: data,
    update: data,
  });

  return NextResponse.json(
    { id: record.id, sourceRef: record.sourceRef, created: existing === null },
    { status: existing === null ? 201 : 200 },
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = authorised(request);
  if (!access.ok) return access.response;

  const drafts = await prisma.scenarioDraft.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      sourceRef: true,
      source: true,
      title: true,
      summary: true,
      engine: true,
      difficulty: true,
      tags: true,
      createdAt: true,
      reviewedById: true,
      scenarioId: true,
    },
  });

  return NextResponse.json({ drafts });
}
