"use client";

/**
 * Claim on view: the ticket in front of you becomes yours.
 *
 * The rule lives in `claim-rules.ts` and the write lives in the ticket service, so this
 * component does exactly one thing — it fires the claim once, when the page that is already
 * rendered says one is due. It is deliberately silent: the ticket's own panel shows the
 * assignee and the status, so a banner would be telling the reader what they can already
 * see, and a claim that was refused (somebody else's work) has nothing to announce.
 *
 * The `claim` flag is what stops this from being a loop, and it is worth being precise
 * about why: the server computes it *before* the write, and after the claim is applied the
 * same computation returns `false` for a ticket that is now the viewer's and already in
 * pending. So the refresh that follows re-renders a page that renders no trigger, and the
 * two states cannot chase each other. The ref is the second guard: a React remount (or a
 * strict-mode double effect in development) fires at most once per mounted page anyway.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export interface AutoClaimProps {
  ticketId: string;
  /** Whether the rule says opening this ticket should take it. */
  claim: boolean;
  /** The server action that takes it. */
  action: (ticketId: string) => Promise<unknown>;
}

export function AutoClaim({ ticketId, claim, action }: AutoClaimProps) {
  const router = useRouter();
  const fired = useRef(false);

  useEffect(() => {
    if (!claim || fired.current) return;
    fired.current = true;
    void action(ticketId).then(() => router.refresh());
  }, [claim, ticketId, action, router]);

  return null;
}
