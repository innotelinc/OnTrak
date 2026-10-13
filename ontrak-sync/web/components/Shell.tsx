"use client";

/**
 * The application shell: the session gate, the navigation, and the numbers that
 * sit beside it.
 *
 * THE THREE STATES THIS PAGE MUST NOT CONFUSE
 * -------------------------------------------
 *  1. **Loading** — the identity has not been read yet. Showing the login form
 *     here makes it flash for people who are already signed in, and showing the
 *     dashboard makes it flash for people who are not.
 *  2. **Signed out** — a 401. Draw the login page.
 *  3. **Broken** — the API did not answer, or answered 5xx. Draw the page it could
 *     not load *underneath* an explanation. Never the login form: a login page for
 *     a server fault trains people to type their password into whatever answers
 *     next.
 *
 * The navigation is filtered by capability, from the same table the server
 * authorises with. Hiding a link is a courtesy, not a control — every route behind
 * it re-checks — but showing a link that always 403s is how a role silently
 * becomes "the person who cannot do their job".
 *
 * The masthead above the rail is the family's, and it is the same one the portal
 * draws on every page: the product's mark, its name and the family's address, with
 * who the console thinks you are on the right. Sync used to carry its name only in
 * a small block at the top of the rail, which read as a tool with its own chrome
 * rather than as one of the products — and the address a person needs when they are
 * about to hand out a link was nowhere on the screen.
 *
 * **Signed out, the frame is drawn too, and that is the point of `GateFrame`.** A
 * person arrives at `sync.ontrak.innotel.us` — the root, because that is the address
 * every link and tile in the family publishes — and this used to answer with a bare
 * sign-in card: no mark, no name, no family address, nothing that said which product
 * they had reached. The portal's own front door has its masthead, so the family's
 * console looked like something somebody had pasted beside it. The gate is now inside
 * the same frame the `/login` route draws, which means the front door is identical
 * whichever of the two addresses a person used.
 *
 * The one place it is *not* drawn is on the sign-in routes themselves (`/login`,
 * `/login/break-glass`): those pages render the frame in their own file, and a shell
 * that drew a second one would be two headers over one screen.
 *
 * `domain` arrives as a prop because this is a client component and
 * `ONTRAK_PORTAL_BASE_DOMAIN` is a server-side variable: reading it here would print
 * one host in the server's markup and another after hydration. The layout passes it
 * through `familyDomain()` (`lib/family.ts`), the same call the login page makes.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { ApiError, api } from "@/lib/api";
import { can, isService, useSession } from "@/lib/session";
import type { Capability, Summary } from "@/lib/types";

import { GateFrame } from "./GateFrame";
import { LoginPanel } from "./LoginPanel";
import { SyncMastheadMark } from "./ProductMark";
import { ThemeToggle } from "./ThemeToggle";

interface NavLink {
  href: string;
  label: string;
  badge?: "pending" | "failed";
  needs?: Capability;
}

const LINKS: NavLink[] = [
  { href: "/", label: "Dashboard" },
  { href: "/findings", label: "Findings", badge: "pending" },
  { href: "/rollouts", label: "Rollouts" },
  { href: "/hosts", label: "Hosts" },
  { href: "/runs", label: "Runs & log" },
  { href: "/settings", label: "Timer & policy", needs: "sync:configure" },
  { href: "/users", label: "People", needs: "users:manage" },
  { href: "/account", label: "Account" },
];

/** Where the front door and the sibling products live. */
const FAMILY: { href: string; label: string; note: string }[] = [
  { href: "https://ontrak.innotel.us", label: "OnTrak Unity", note: "all products" },
  { href: "https://its.ontrak.innotel.us", label: "OnTrak ITS", note: "training" },
  { href: "https://tix.ontrak.innotel.us", label: "OnTrak Tix", note: "the desk" },
  { href: "https://sentinel.ontrak.innotel.us", label: "OnTrak Sentinel", note: "identity & IDS" },
];

export function Shell({ domain, children }: { domain: string; children: ReactNode }) {
  const pathname = usePathname();
  const { identity, loading, error, signOut, adopt } = useSession();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!identity) return;
    try {
      setSummary(await api.summary());
      setApiError(null);
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 401 || cause.forbidden)) {
        // A 403 here means the account may not read the Network at all. That is not
        // an error on this page — the nav simply has no counts.
        setSummary(null);
        return;
      }
      setApiError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [identity]);

  useEffect(() => {
    void load();
  }, [load, pathname]);

  // The sign-in pages draw themselves, with no shell around them: a navigation
  // sidebar next to a login form is an invitation to click into pages that will
  // refuse. The break-glass door is one of them, and it must be reachable *while
  // signed out* — that is the entire point of it. They draw their own frame, which
  // is the same one the signed-out branch below draws: one definition, two routes.
  if (pathname === "/login" || pathname === "/login/break-glass") {
    return <>{children}</>;
  }

  if (loading) {
    return <div className="empty">Loading…</div>;
  }

  // Signed out on any *other* route: the same gate, inside the family's frame. The
  // masthead is the portal's, so somebody who followed a tile here can see they are
  // at the product they clicked, and where the rest of the family lives, before they
  // have signed in to anything.
  if (!identity) {
    return (
      <GateFrame domain={domain}>
        <LoginPanel
          notice={error ?? null}
          onSignedIn={(user) => {
            adopt({ ...user, via: "cookie" });
          }}
        />
      </GateFrame>
    );
  }

  const visible = LINKS.filter((link) => !link.needs || can(identity, link.needs));

  return (
    <div className="shell">
      <header className="masthead">
        <a className="masthead__brand" href="/">
          {/* The family's shield with Sync's cycle in it, at the masthead's size; the
              name is in text beside it, so the mark is decoration here. */}
          <SyncMastheadMark />
          <strong>OnTrak Sync</strong>
          <span>{domain}</span>
        </a>
        <div className="masthead__tools">
          <span className="masthead__who">{identity.display_name || identity.username}</span>
          <span className="pill pill--role">{identity.role}</span>
          <ThemeToggle />
        </div>
      </header>

      <div className="shell__body">
        <nav className="nav">
          {visible.map((link) => {
            const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            const value = link.badge && summary ? summary[link.badge] : 0;
            return (
              <Link key={link.href} href={link.href} className={active ? "active" : undefined}>
                <span>{link.label}</span>
                {link.badge && value ? (
                  <span className={link.badge === "failed" || active ? "count alert" : "count"}>
                    {value}
                  </span>
                ) : null}
              </Link>
            );
          })}

          <div className="nav-group">
            <span className="nav-group__label">Family</span>
            {FAMILY.map((link) => (
              <a key={link.href} href={link.href} target="_blank" rel="noreferrer">
                <span>{link.label}</span>
                <span className="nav-note">{link.note}</span>
              </a>
            ))}
          </div>

          {/* Who you are is in the masthead, so the rail's foot is the two things a
              masthead does not carry: where to change your password, and the way out. */}
          <div className="nav-user">
            {isService(identity) ? (
              <p className="faint" style={{ margin: 0 }}>
                deployment token
              </p>
            ) : (
              <Link href="/account" className="faint">password &amp; sessions</Link>
            )}
            <button
              className="ghost"
              style={{ width: "100%", marginTop: 8 }}
              onClick={() => void signOut()}
            >
              Sign out
            </button>
          </div>
        </nav>
        <main className="main">
          {apiError ? (
            <div className="note note--bad">
              The dashboard cannot reach the API: {apiError}
            </div>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}
