"use client";

import { useEffect, useState } from "react";

import { Alert, Card, SectionHeading } from "@/components/ui";
import type { MachineAddress } from "@/lib/lab/portal";

/**
 * How often the console asks whether its session is still a machine.
 *
 * Ten seconds is a compromise with a reason on both sides: often enough that a student
 * who quits a session in another tab stops paying for a dead tunnel within a glance,
 * and rare enough that a page left open all afternoon is one small request every ten
 * seconds rather than a load of its own.
 */
const WATCH_INTERVAL_MS = 10_000;

/**
 * The machine, in the browser.
 *
 * The console is an iframe onto `/lab/sessions/<id>/console`, a route which mints a signed,
 * short-lived Guacamole payload and redirects to the gateway. The signed payload is
 * deliberately *not* in this page's HTML: it is a bearer credential for one machine, and a
 * copy of it scraped from a page is a copy that outlives the page. Minting it per load also
 * means a student who leaves a tab open overnight comes back to a fresh link rather than to
 * "permission denied".
 *
 * **And it stops when the session does.** That link is valid for `guac.link_ttl_minutes`,
 * which is longer than a session can be recycled in, so a console left open across an end —
 * "End the session and destroy the machine", a time limit, the reaper, a quit from another
 * tab — keeps a signed credential for an address that has since been handed back to the
 * pool. Guacamole's answer to a tunnel it cannot open is to retry: the student is told "the
 * remote desktop server encountered an error and has closed the connection", and the
 * attempts go on against an address that belongs to nobody, or to whichever machine was
 * lent it next. This was measured on a live deployment rather than imagined — 43 attempts
 * at ~3.1s each, every one of them against a single recycled address.
 *
 * So the page watches the session rather than trusting the link, and the frame is *unmounted*
 * when the session stops being one: removing it is what closes the tunnel, and the panel then
 * says so in place of the frame it can no longer honour.
 *
 * The watch is deliberately this component's own state rather than a `router.refresh()`: a
 * console is one panel on a page whose other controls are server actions that a reload would
 * re-read anyway, and keeping the decision here means the panel renders the same way in a
 * static a11y render as it does in the app — which is how the "ended" state gets checked
 * rather than assumed.
 *
 * What is drawn beside the console is the answer to a question the page used to get wrong:
 * the guests live on the lab's own bridge, so the address identifies the machine and does
 * not route from a student's own network. Saying that next to the address is cheaper than a
 * support ticket that starts "I tried to ssh in and it timed out".
 */
export function SessionConsole({
  sessionId,
  available,
  address,
  reason,
  usable,
}: {
  sessionId: number;
  /** Whether a signed link exists at all — no gateway, or no address yet, means no. */
  available: boolean;
  address: MachineAddress;
  /** Why there is no console, when there is none. Shown instead of an empty frame. */
  reason?: string;
  /** Whether the session is one a machine can still be used through, as the server read it. */
  usable: boolean;
}) {
  // Starts from the server's own answer, so a page rendered for a finished session never
  // opens a tunnel at all — the watch below is only for one that ends while it is open.
  const [running, setRunning] = useState(available && usable);
  const [ended, setEnded] = useState(available && !usable);

  useEffect(() => {
    if (!running) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      let stillUsable = true;
      try {
        const response = await fetch(`/api/v1/lab/sessions/${sessionId}/status`, {
          cache: "no-store",
        });
        // A session that is gone is answered 404 by the route, and that is the same fact
        // as an unusable one: there is no machine behind this link any more. Anything
        // else is read for the portal's own word for "the machine can be touched".
        stillUsable = response.ok
          ? ((await response.json()) as { ready?: boolean }).ready === true
          : false;
      } catch {
        // A dropped poll is a dropped request, not a dead machine: ask again on the same
        // cadence rather than tearing down a console somebody is still working in.
        stillUsable = true;
      }
      if (cancelled) return;
      if (!stillUsable) {
        // Unmounting the frame is the whole point: it is what ends the retry loop.
        setRunning(false);
        setEnded(true);
        return;
      }
      timer = setTimeout(() => void tick(), WATCH_INTERVAL_MS);
    };

    timer = setTimeout(() => void tick(), WATCH_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [running, sessionId]);

  return (
    <Card className="space-y-3">
      <SectionHeading
        title="Machine console"
        description={
          address.host === ""
            ? "The machine has no address yet."
            : `${address.transport} on ${address.reach}`
        }
      />

      {running ? (
        <iframe
          // A named frame, because a screen reader announces it and a student can tell the
          // console apart from the rest of the page.
          title={`Console for session ${sessionId}`}
          src={`/lab/sessions/${sessionId}/console`}
          className="h-[70vh] w-full rounded-xl2 border border-line bg-black/90"
        />
      ) : ended ? (
        <Alert tone="amber" title="This session has ended">
          The machine was destroyed, so its console is closed — the address it had is no
          longer yours. Nothing is left running against it. Start the scenario again from{" "}
          <a href="/lab" className="font-semibold underline">
            All machines
          </a>{" "}
          when you want another.
        </Alert>
      ) : (
        <Alert tone="amber" title="No console for this machine">
          {reason ??
            "There is nothing to open yet: the machine is still starting, or this deployment has no console gateway configured."}
        </Alert>
      )}

      {address.host !== "" ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-ink-faint">
          <dt className="font-semibold text-ink-soft">Address</dt>
          <dd className="font-mono">{address.host}</dd>
          <dt className="font-semibold text-ink-soft">Reach it with</dt>
          <dd className="font-mono">{address.target}</dd>
          <dt className="font-semibold text-ink-soft">Account</dt>
          <dd className="font-mono">{address.user}</dd>
          <dt className="font-semibold text-ink-soft">Where that works</dt>
          {/* The address is an identifier, not a destination: the lab's bridge does not
              route from outside it, so the console above is the way in. */}
          <dd>{address.reach} — the address does not route from outside it, so use the console.</dd>
        </dl>
      ) : null}
    </Card>
  );
}
