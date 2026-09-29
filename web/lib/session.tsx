"use client";

/**
 * Who is signed in, for the whole dashboard.
 *
 * One provider rather than a fetch per page, because every page needs the same
 * two answers — *may I see this* and *may I change it* — and a component that
 * answers them from its own request eventually answers them differently from the
 * navigation beside it. That is how a signed-in technician ends up looking at an
 * Apply button the server will refuse.
 *
 * The distinction this file exists to preserve: **signed out** is not **failed**.
 * A 401 makes `identity` null and the shell draws the login page; anything else
 * (the API is down, the network is gone) is an `error` the shell shows *over* the
 * page, because silently rendering a login form for a 500 trains people to type
 * their password into whatever the server sends next.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from "react";

import { ApiError, api, CROSS_ORIGIN, getToken } from "./api";
import type { Capability, Identity, ProductKey } from "./types";

export interface SessionState {
  /** The signed-in identity, or null when nobody is signed in. */
  identity: Identity | null;
  /** True until the first answer arrives — never "signed out" prematurely. */
  loading: boolean;
  /** Set when the answer could not be obtained at all (not a 401). */
  error: string | null;
  /** Re-read the identity, e.g. after a role change. */
  refresh: () => void;
  /** Sign out and drop the local credential. */
  signOut: () => Promise<void>;
  /** Replace the identity after a sign-in without a round trip. */
  adopt: (identity: Identity) => void;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // In the cross-origin deployment there is no cookie to fall back on, so a
    // missing token means "signed out" without a request that is certain to 401.
    // In the same-origin deployment the cookie is invisible to JavaScript, so the
    // request is the only way to find out — and the shell shows a brief loading
    // state rather than a login form that flickers for people who are signed in.
    if (CROSS_ORIGIN && !getToken()) {
      setIdentity(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    api
      .me()
      .then((value) => {
        if (cancelled) return;
        setIdentity(value);
        setError(null);
      })
      .catch((cause) => {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 401) {
          // A refusal. The shell draws the login page.
          setIdentity(null);
          setError(null);
          return;
        }
        // Anything else — 0 for an unreachable API, 5xx, a 403 from a session
        // whose role changed under it — is a fault to SHOW, not a login prompt.
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const signOut = useCallback(async () => {
    // The server call is what actually revokes the session; the local state is
    // cleared either way so a failed logout cannot strand a credential on screen.
    try {
      await api.signOut();
    } catch {
      // ignored on purpose — see above
    }
    setIdentity(null);
    setError(null);
  }, []);

  const value = useMemo<SessionState>(() => ({
    identity,
    loading,
    error,
    signOut,
    adopt: (next) => setIdentity(next),
    refresh: () => setNonce((current) => current + 1),
  }), [identity, loading, error, signOut]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error("useSession() was used outside <SessionProvider>");
  }
  return value;
}

/**
 * Whether the current identity holds a capability.
 *
 * Consults the capabilities the *server* returned, never a role comparison here:
 * one table decides, and it is the same table the API checks.
 */
export function can(identity: Identity | null, capability: Capability): boolean {
  return Boolean(identity?.capabilities?.includes(capability));
}

export function isService(identity: Identity | null): boolean {
  return Boolean(identity && "service" in identity && identity.service);
}

export function productsOf(identity: Identity | null): ProductKey[] {
  return identity?.products ?? [];
}
