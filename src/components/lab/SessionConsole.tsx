import { Alert, Card, SectionHeading } from "@/components/ui";
import type { MachineAddress } from "@/lib/lab/portal";

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
}: {
  sessionId: number;
  /** Whether a signed link exists at all — no gateway, or no address yet, means no. */
  available: boolean;
  address: MachineAddress;
  /** Why there is no console, when there is none. Shown instead of an empty frame. */
  reason?: string;
}) {
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

      {available ? (
        <iframe
          // A named frame, because a screen reader announces it and a student can tell the
          // console apart from the rest of the page.
          title={`Console for session ${sessionId}`}
          src={`/lab/sessions/${sessionId}/console`}
          className="h-[70vh] w-full rounded-xl2 border border-line bg-black/90"
        />
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
