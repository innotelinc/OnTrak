"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ProgressBar } from "@/components/ui";

/** How often the page asks. Two seconds is the Python portal's own interval. */
const INTERVAL_MS = 2_000;
/** Stop asking after this long, so a host that never answers does not poll forever. */
const GIVE_UP_MS = 15 * 60_000;

/**
 * While a machine is being prepared, keep the page honest.
 *
 * Cloning and booting takes tens of seconds and the provisioning runs *after* the response
 * (see `actions/lab.ts`), so the page a student lands on says "preparing your machine" and
 * has to find out when that stops being true. This polls the small JSON route and calls
 * `router.refresh()` when the answer changes, which re-renders the server component — so
 * the console, the check button and the write-up form all appear together, from the same
 * fetch, and the browser holds no state the server does not.
 *
 * It also stops: a machine that never becomes ready is a support case, not a reason for a
 * tab to make a request every two seconds until it is closed.
 */
export function SessionPoller({
  sessionId,
  ready,
  initial,
  timeoutMs = GIVE_UP_MS,
}: {
  sessionId: number;
  /** Whether the session is usable *now*, server-rendered. */
  ready: boolean;
  /** Where the bar starts, so a page render and the first poll do not disagree. */
  initial: number;
  timeoutMs?: number;
}) {
  const router = useRouter();
  const [percent, setPercent] = useState(initial);
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    if (ready) return undefined;
    let cancelled = false;
    const started = Date.now();

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      if (Date.now() - started > timeoutMs) {
        setStopped(true);
        return;
      }
      try {
        const response = await fetch(`/api/v1/lab/sessions/${sessionId}/status`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const status = (await response.json()) as {
          state?: string;
          ready?: boolean;
          progress?: number;
        };
        if (cancelled) return;
        if (typeof status.progress === "number") setPercent(status.progress);
        if (status.ready === true || status.state === "error" || status.state === "destroyed") {
          router.refresh();
          return;
        }
        setTimeout(tick, INTERVAL_MS);
      } catch {
        // A failed poll is a dropped request, not a failed machine: try again on the same
        // cadence rather than surfacing an error the student can do nothing about.
        if (!cancelled) setTimeout(tick, INTERVAL_MS);
      }
    };

    setTimeout(tick, INTERVAL_MS);
    return () => {
      cancelled = true;
    };
  }, [ready, router, sessionId, timeoutMs]);

  if (ready) return null;

  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <ProgressBar value={percent} label="Preparing your machine" />
      <p className="text-xs text-ink-faint">
        {stopped
          ? "This is taking longer than usual. Reload the page, or ask your instructor to check the range."
          : "Cloning and booting takes a few seconds. This page updates itself."}
      </p>
    </div>
  );
}
