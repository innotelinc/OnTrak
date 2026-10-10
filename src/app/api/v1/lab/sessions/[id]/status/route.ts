/**
 * `GET /api/v1/lab/sessions/<id>/status` — one session, as the page's poller reads it.
 *
 * A machine takes tens of seconds to clone and boot, and the provisioning runs after the
 * response that asked for it, so the page a student lands on has to find out when that
 * stops being true. This is the small, cheap answer: no HTML, no database work beyond the
 * one row, and `no-store` so a poll is never answered from a cache that remembers a
 * machine which is now ready.
 *
 * The body's field names are the Python portal's (see `sessionStatus`), because this is the
 * one lab surface a student's own script or an operator's `curl` may already be parsing.
 *
 * Ownership is the session manager's decision, not this route's: `getOwnedSession` refuses
 * somebody else's session for a student and allows it for staff. A session that is not
 * there and a session that is not yours are answered the same way — 404 — because telling
 * them apart would let a signed-in student enumerate sessions.
 */

import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { sessionStatus } from "@/lib/lab/portal";
import { consoleUrl } from "@/lib/lab/portal";
import { SessionError } from "@/lib/lab/sessions";
import { labRuntimeForPage } from "@/lib/lab/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function notFound(): NextResponse {
  return NextResponse.json({ error: "No such session." }, { status: 404 });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const { runtime } = await labRuntimeForPage();
  if (!runtime) return notFound();

  const { id } = await params;
  const sessionId = Number(id);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return notFound();

  const staff = user.role === "INSTRUCTOR" || user.role === "ADMIN";
  let session;
  try {
    session = await runtime.manager.getOwnedSession(user.email.trim().toLowerCase(), sessionId, staff);
  } catch (error) {
    if (error instanceof SessionError) return notFound();
    throw error;
  }

  const scenario = runtime.repository.get(session.scenarioId);
  const hasConsole = consoleUrl(runtime.settings, session, scenario) !== "";
  return NextResponse.json(sessionStatus(session, hasConsole), {
    headers: { "cache-control": "no-store" },
  });
}
