/**
 * `GET /lab/sessions/<id>/console` — the console iframe's source.
 *
 * The page embeds this route rather than the signed Guacamole URL, and the reason is the
 * credential: the link is a bearer token for one machine with a short life, and a copy of
 * it in a page's HTML is a copy that outlives the page (a shared screenshot, a saved tab, a
 * proxy log). Minting it per load also means a student who leaves the page open overnight
 * comes back to a fresh link instead of "permission denied".
 *
 * The gateway itself is the one route whose *contract* the port keeps (docs/lab-port.md
 * §3/C7): operators and the family's portal reach it at the path Guacamole is configured
 * under, and nothing here changes what it answers.
 *
 * Ownership is `getOwnedSession`'s, exactly as the status route asks it: a student may open
 * their own machine's console, staff may open any. No console (no gateway, no address yet,
 * a Linux image with no sshd) is a redirect back to the session with the reason rather than
 * an empty frame.
 */

import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth";
import { consoleUrl } from "@/lib/lab/portal";
import { SessionError } from "@/lib/lab/sessions";
import { labRuntimeForPage } from "@/lib/lab/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getSession();
  if (!user) redirect("/login");

  const { runtime, reason } = await labRuntimeForPage();
  const { id } = await params;
  if (!runtime) redirect(`/lab?error=${encodeURIComponent(reason ?? "OnTrak Lab is not available.")}`);

  const sessionId = Number(id);
  if (!Number.isInteger(sessionId) || sessionId <= 0) redirect("/lab?error=No%20such%20session.");

  const staff = user.role === "INSTRUCTOR" || user.role === "ADMIN";
  let session;
  try {
    session = await runtime.manager.getOwnedSession(user.email.trim().toLowerCase(), sessionId, staff);
  } catch (error) {
    if (error instanceof SessionError) {
      redirect(`/lab?error=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }

  const scenario = runtime.repository.get(session.scenarioId);
  const url = consoleUrl(runtime.settings, session, scenario);
  if (url === "") {
    const why = session.hostIp
      ? "This machine has no browser console: guac.base_url or guac.secret_key is not configured, or the guest runs no remote desktop."
      : "This machine has no address yet, so there is no console to open.";
    redirect(`/lab/sessions/${sessionId}?error=${encodeURIComponent(why)}`);
  }

  // 307, because a console is a GET that must stay a GET: a browser that re-requested it as
  // a POST would be handed the same link, and the gateway would answer it the same way, but
  // the intent is clearer this way.
  return new Response(null, {
    status: 307,
    headers: { location: url, "cache-control": "no-store" },
  });
}
