import type { ReactNode } from "react";

import { SyncMastheadMark } from "./ProductMark";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The page a signed-out visitor lands on: the family's masthead above, the product's
 * own footer below, and the gate in between.
 *
 * Two callers, and both of them are a front door:
 *
 *  * the standalone `/login` route, which exists so a link, a bookmark or the SSO
 *    callback can name a destination;
 *  * the shell, for a signed-out visitor on any *other* route. That is the address
 *    every tile in the family publishes (`sync.ontrak.innotel.us`, the root), and
 *    without the frame it answered with a bare card and no sign of which product it
 *    was — the portal draws its masthead there, so the family's console looked like
 *    an afterthought beside it.
 *
 * It is one component rather than two frames drawn to look alike, because two copies
 * of a header is how one of them ends up with a different name under the mark. The
 * signed-in console's masthead is the shell's own: same mark, same shape, with who
 * the console thinks you are on the right — drawn there rather than here because only
 * then is there somebody to sign out.
 *
 * `domain` arrives as a prop rather than being read here because the callers sit
 * above client components: `ONTRAK_PORTAL_BASE_DOMAIN` is a server-side variable, and
 * a client component reading it would name one host in the server's markup and another
 * one after hydration.
 */
export function GateFrame({ domain, children }: { domain: string; children: ReactNode }) {
  return (
    <div className="page">
      <header className="masthead">
        <a className="masthead__brand" href="/">
          <SyncMastheadMark />
          <strong>OnTrak Sync</strong>
          <span>{domain}</span>
        </a>
        <div className="masthead__tools">
          <ThemeToggle />
        </div>
      </header>

      <main className="page__main">{children}</main>

      <footer className="footer">
        <span>OnTrak Sync</span>
      </footer>
    </div>
  );
}

export default GateFrame;
