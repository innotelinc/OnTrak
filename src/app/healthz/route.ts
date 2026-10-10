/**
 * `GET /healthz` — OnTrak Lab's liveness, at the path the family already probes.
 *
 * The family has two liveness conventions, and they are not interchangeable. Every product
 * answers `/health` unauthenticated (`src/app/health/route.ts`, which this app keeps for
 * itself); the **lab** answers `/healthz`, and that is what the portal catalogue names for
 * its tile and what the control room's capabilities panel probes
 * (`ontrak-portal/src/lib/portal-rules.ts`, `src/lib/capabilities.ts`). A lab that moved to
 * `/health` would draw a false "not answering" light, which is the exact failure the
 * portal's own comments were written to avoid.
 *
 * Two things this route decides on purpose:
 *
 * **It answers only when this deployment *is* the lab.** The in-app door is the fact that
 * makes this app a lab; without it the route 404s, so a deployment linking to a peer's lab
 * does not also advertise one of its own — the peer answers its own `/healthz`, and two
 * lights for one product is worse than one.
 *
 * **A lab that will not open is a 503 with the reason, not a 200.** The Python's `/healthz`
 * counted scenarios and nothing else, so a host with no password configured still looked
 * healthy. This one asks the runtime to open, which is the same call a page makes: a green
 * light nobody tested is worse than a red one with a sentence under it.
 *
 * Unauthenticated, and deliberately outside the middleware's matcher: a health check needs
 * no credential, and the answer is a count and a status word.
 */

import { NextResponse } from "next/server";

import { labDoorFromEnv } from "@/lib/lab-rules";
import { labRuntime } from "@/lib/lab/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const headers = { "cache-control": "no-store" };

  if (labDoorFromEnv().kind !== "in-app") {
    return NextResponse.json(
      { status: "not-a-lab", detail: "This deployment does not run OnTrak Lab." },
      { status: 404, headers },
    );
  }

  const read = await labRuntime();
  if (!read.ok) {
    return NextResponse.json({ status: "unavailable", detail: read.reason }, { status: 503, headers });
  }

  return NextResponse.json(
    {
      status: "ok",
      // The Python's own body, kept field for field: a probe that has been reading this for
      // a year should not have to learn a new one.
      scenarios: read.runtime.repository.list().length,
      mode: read.runtime.mode,
      hypervisor: read.runtime.hypervisor,
    },
    { headers },
  );
}
