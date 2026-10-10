/**
 * `POST /api/v1/lab/completions` — a finished lab session, recorded as a graded attempt.
 *
 * The lab (OnTrak-dev) grades a task against a live machine. This is the door that
 * accepts the result and writes it into the family's one ledger
 * (docs/consolidation-audit.md §9/Q3): the attempt, its check results, its
 * certificate and its evidence all land here, with `gradingMode = 'lab'`, so the
 * instructor view and the results feed see it beside the simulated attempts.
 * The full contract is in [lab-completion.md](../../../../../../docs/lab-completion.md).
 *
 *   POST /api/v1/lab/completions
 *   Authorization: Bearer $ONTRAK_API_TOKEN
 *   { "format": "ontrak.lab.completion/v1", "sessionId": "sess-1",
 *     "learnerEmail": "ada@acme.test", "scenarioSlug": "broken-nic",
 *     "score": 8, "maxScore": 10, "completedAt": "2026-10-05T09:20:00.000Z" }
 *
 * The token is the deployment's shared API token, the same one the read routes use:
 * this is a machine-to-machine call with no browser and no user. Unconfigured is a
 * 503 with a reason, not a 401.
 *
 * **What this file is now.** The write itself — idempotency, the task/mode agreement,
 * the transaction, the certificate, the audit entry, the graded announcement — moved to
 * `src/lib/lab-completion-record.ts` in stage 3, because the ported control plane finishes
 * sessions of its own and has to produce exactly the same rows. What is left here is the
 * door's own business: the bearer token, JSON parsing, and the HTTP status a refusal
 * deserves. Nothing about *what* is written is decided twice.
 */

import { NextResponse, type NextRequest } from "next/server";

import { apiAccess } from "../../_access";
import { readLabCompletion } from "@/lib/lab-completion-rules";
import { recordLabCompletion } from "@/lib/lab-completion-record";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = apiAccess(request);
  if (!access.ok) return access.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "The body was not JSON." }, { status: 400 });
  }

  const read = readLabCompletion(body);
  if (!read.ok) {
    return NextResponse.json({ error: "The lab completion is not usable.", issues: read.issues }, { status: 422 });
  }

  const wrote = await recordLabCompletion(read.value);
  if (!wrote.ok) {
    return NextResponse.json({ error: wrote.error }, { status: wrote.status });
  }

  return NextResponse.json(
    { ok: true, attemptId: wrote.attemptId, created: wrote.created },
    { status: wrote.created ? 201 : 200 },
  );
}
