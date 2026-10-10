/**
 * `GET /instructor/lab/results-detail.csv` — one line per submission, blend included.
 *
 * The Python portal had two exports and this is its other one (`/admin/results.csv`): where
 * `results.csv` answers "how is the class doing, per student and scenario", this answers
 * "what did each submission actually consist of". It exists here for a reason stage 3a
 * created: a grade is now two halves — machine state and the written ticket — and an
 * instructor auditing a mark needs to see which half carried it. A write-up that was never
 * submitted is an empty field rather than a zero, because zero is a mark a student can earn.
 *
 * Staff only (the middleware gates `/instructor/*`, and the real user is read again below).
 */

import { notFound } from "next/navigation";

import { requireSession } from "@/lib/auth";
import { classResults } from "@/lib/lab/reporting";
import { csvHeaders, resultsCsv } from "@/lib/lab/portal";
import { labRuntimeForPage } from "@/lib/lab/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const user = await requireSession();
  if (user.role === "STUDENT") notFound();

  const { runtime } = await labRuntimeForPage();
  if (!runtime) {
    return new Response("OnTrak Lab is not running on this deployment.\n", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  // The Python named it `ontrak-results.csv` too; two downloads with one name would
  // overwrite each other in a browser's download folder, so the detail export is named
  // after what it carries.
  return new Response(resultsCsv(await classResults(runtime)), {
    headers: csvHeaders("ontrak-lab-results-detail.csv"),
  });
}
