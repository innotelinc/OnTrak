"use client";

/**
 * The application shell: the token gate, the navigation, and the numbers that sit
 * beside it.
 *
 * The gate is the first thing every page needs, so it lives here rather than in
 * each page. It distinguishes "no token yet" from "the token was rejected" — the
 * first shows the form, the second shows the form with an explanation — because an
 * operator whose token has been rotated should not be left wondering whether the
 * API is down.
 *
 * The nav counts come from the summary endpoint, and the one that is coloured is
 * `pending`: it is the number that means "someone has to decide", as opposed to
 * `unknown`, which means "we could not look" and is shown separately on the
 * dashboard rather than being used as a badge.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { ApiError, api, getToken, setToken } from "@/lib/api";
import type { Summary } from "@/lib/types";

const LINKS: { href: string; label: string; badge?: "pending" | "failed" }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/findings", label: "Findings", badge: "pending" },
  { href: "/hosts", label: "Hosts" },
  { href: "/runs", label: "Runs & log" },
  { href: "/settings", label: "Timer & policy" },
];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [token, setTokenState] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    setTokenState(getToken());
  }, []);

  const load = useCallback(async () => {
    if (!getToken()) return;
    try {
      setSummary(await api.summary());
      setApiError(null);
      setRejected(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setRejected(true);
      } else {
        setApiError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, []);

  useEffect(() => {
    if (token) void load();
  }, [token, load, pathname]);

  if (token === null) {
    return <div className="empty">Loading…</div>;
  }

  if (!token || rejected) {
    return (
      <TokenGate
        rejected={rejected}
        onSave={(value) => {
          setToken(value);
          setTokenState(value);
          setRejected(false);
        }}
      />
    );
  }

  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">
          <strong>Ontrak Sync</strong>
          <span>updates</span>
        </div>
        {LINKS.map((link) => {
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
        <div style={{ padding: "10px 16px", marginTop: 8, borderTop: "1px solid var(--line)" }}>
          <button
            className="ghost"
            style={{ width: "100%" }}
            onClick={() => {
              setToken("");
              setTokenState("");
              setSummary(null);
            }}
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

function TokenGate({ rejected, onSave }: { rejected: boolean; onSave: (token: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="gate">
      <h1>Ontrak Sync</h1>
      <p>
        Enter the API token for this deployment. It is the value in
        {" "}
        <code>ONTRAK_API_TOKEN</code>
        {" "}
        on the host running the service, and it is stored in this browser only.
      </p>
      {rejected ? (
        <div className="note note--bad">That token was rejected (401). Check it against the host&apos;s <code>.env</code>.</div>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) onSave(value.trim());
        }}
      >
        <label className="field">
          <span>API token</span>
          <input
            type="password"
            value={value}
            autoFocus
            autoComplete="off"
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <button className="primary" type="submit" disabled={!value.trim()}>
          Continue
        </button>
      </form>
    </div>
  );
}
