/**
 * `GET /instructor/results.csv` — the class's marks, as a download.
 *
 * The path, the file name and the header row are the Python portal's, kept exactly
 * (docs/lab-port.md §3/C7): an operator's script and the family's own runbooks name this
 * URL, and a port that moved it would break a command somebody already has in a terminal.
 *
 * One line per (student, scenario) rather than per attempt, with `attempts` and the best
 * score — the Python's own `leaderboard` SQL, which is `leaderboardRows` here, so the page
 * and the export cannot disagree about what "best" is. The per-result export, with the
 * machine half, the write-up half and the blend, is `/instructor/lab/results-detail.csv`.
 *
 * Staff only, and unauthenticated requests never reach here: the middleware gates
 * `/instructor/*` by role before this runs, and the real user record is read again below so
 * a deactivated account is refused on its next navigation.
 */

import { notFound } from "next/navigation";

import { requireSession } from "@/lib/auth";
import { classResults } from "@/lib/lab/reporting";
import { csvHeaders, leaderboardCsv, leaderboardRows } from "@/lib/lab/portal";
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

  const rows = leaderboardRows(await classResults(runtime));
  return new Response(leaderboardCsv(rows), { headers: csvHeaders() });
}
