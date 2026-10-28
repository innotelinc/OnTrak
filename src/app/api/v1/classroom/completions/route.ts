/**
 * `POST /api/v1/classroom/completions` — a finished classroom lesson, recorded as a
 * verifiable training record (Class 2.1).
 *
 * The classroom (AthenIQ's OpenMAIC host) grades its own quizzes. This is the door
 * that accepts the outcome and files it in *this* deployment's ledger: a
 * `ClassroomCompletion` row, a completion record stored on it when the score
 * cleared the pass mark, and an audit entry. The classroom's own progress page is
 * not the record of record; this is. The full contract is in
 * [classroom-completion.md](../../../../../../docs/classroom-completion.md).
 *
 *   POST /api/v1/classroom/completions
 *   Authorization: Bearer $ONTRAK_API_TOKEN
 *   { "format": "ontrak.classroom.completion/v1",
 *     "completionId": "openmaic:cls-1:learner-1:lesson-3",
 *     "learnerEmail": "ada@acme.test",
 *     "course": { "ref": "ITSP101", "title": "IT Support Foundations" },
 *     "lesson": { "ref": "chapter-3", "title": "Accounts and access" },
 *     "score": 8, "maxScore": 10, "completedAt": "2026-10-05T09:20:00.000Z" }
 *
 * The token is the deployment's shared API token, the same one the read routes and
 * the lab's door use: this is a machine-to-machine call with no browser and no user.
 * Unconfigured is a 503 with a reason, not a 401.
 *
 * What is decided where: the body's shape is the rulebook's
 * (`classroom-completion-rules.ts`), the write — idempotency, the learner, the
 * certificate, the audit entry — is `classroom-completion-record.ts`, and this file
 * keeps only the door's own business: the bearer token, JSON parsing, and the HTTP
 * status a refusal deserves.
 */

import { NextResponse, type NextRequest } from "next/server";

import { apiAccess, badBody } from "../../_access";
import { readClassroomCompletion } from "@/lib/classroom-completion-rules";
import { recordClassroomCompletion } from "@/lib/classroom-completion-record";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = apiAccess(request);
  if (!access.ok) return access.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badBody();
  }

  const read = readClassroomCompletion(body);
  if (!read.ok) {
    return NextResponse.json(
      { error: "The classroom completion is not usable.", issues: read.issues },
      { status: 422 },
    );
  }

  const wrote = await recordClassroomCompletion(read.value);
  if (!wrote.ok) {
    return NextResponse.json({ error: wrote.error }, { status: wrote.status });
  }

  // `id` rather than `attemptId`: a classroom completion is a record of its own, not
  // an attempt filed against a scenario — and the caller can hold it for a retry.
  // The stored record and its code ride along when the lesson passed, because a
  // record nobody can hand to the learner is not yet a verifiable one: the caller
  // shows the code and the JSON, and `/verify` checks either.
  return NextResponse.json(
    {
      ok: true,
      id: wrote.id,
      created: wrote.created,
      ...(wrote.record === null ? {} : { record: wrote.record, code: wrote.code }),
    },
    { status: wrote.created ? 201 : 200 },
  );
}
