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
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { ApiError, api } from "@/lib/api";
import { can, isService, useSession } from "@/lib/session";
import type { Capability, Summary } from "@/lib/types";

import { LoginPanel } from "./LoginPanel";

interface NavLink {
  href: string;
  label: string;
  badge?: "pending" | "failed";
  needs?: Capability;
}

const LINKS: NavLink[] = [
  { href: "/", label: "Dashboard" },
  { href: "/findings", label: "Findings", badge: "pending" },
  { href: "/hosts", label: "Hosts" },
  { href: "/runs", label: "Runs & log" },
  { href: "/settings", label: "Timer & policy", needs: "sync:configure" },
  { href: "/users", label: "People", needs: "users:manage" },
  { href: "/account", label: "Account" },
];

/** Where the portal and the sibling products live. */
const FAMILY: { href: string; label: string; note: string }[] = [
  { href: "https://ontrak.innotel.us", label: "OnTrak Portal", note: "all products" },
  { href: "https://its.ontrak.innotel.us", label: "IT Support Training", note: "students" },
  { href: "https://tix.ontrak.innotel.us", label: "OnTrak Tix", note: "the desk" },
  { href: "https://sentinel.ontrak.innotel.us", label: "OnTrak Sentinel", note: "identity & IDS" },
];

export function Shell({ children }: { children: ReactNode }) {
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
        // A 403 here means the account may not read the estate at all. That is not
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

  // The sign-in page draws itself, with no shell around it: a navigation sidebar
  // next to a login form is an invitation to click into pages that will refuse.
  if (pathname === "/login") {
    return <>{children}</>;
  }

  if (loading) {
    return <div className="empty">Loading…</div>;
  }

  if (!identity) {
    return (
      <LoginPanel
        notice={error ?? null}
        onSignedIn={(user) => {
          adopt({ ...user, via: "cookie" });
        }}
      />
    );
  }

  const visible = LINKS.filter((link) => !link.needs || can(identity, link.needs));

  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">
          <strong>Ontrak Sync</strong>
          <span>updates</span>
        </div>
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

        <div className="nav-user">
          <div className="nav-user__who">
            <strong>{identity.display_name || identity.username}</strong>
            <span className="pill pill--role">{identity.role}</span>
          </div>
          {isService(identity) ? (
            <p className="faint" style={{ margin: "2px 0 0" }}>
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
  );
}
