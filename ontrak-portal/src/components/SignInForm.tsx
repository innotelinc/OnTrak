"use client";

/**
 * The portal's sign-in form.
 *
 * Username and password are delegated to OnTrak Sync; the SSO button is drawn
 * only when the portal can actually complete the handshake. The refusal text is
 * passed through unchanged, including the deliberate refusal to say whether a
 * username exists.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { safeReturnTo } from "@/lib/oidc-rules";

export function SignInForm({ ssoEnabled, providerName, error }: {
  ssoEnabled: boolean;
  providerName: string;
  /** A reason handed in from the callback, shown as-is. */
  error: string | null;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error_, setError] = useState<string | null>(error);
  const [retryAfter, setRetryAfter] = useState(0);
  const [next, setNext] = useState("/");
  const usernameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Read from `location` in an effect rather than during render: the server has
    // no `location`, so computing the SSO `href` inline would render a different
    // value on each side and hydrate with a mismatch.
    const params = new URLSearchParams(window.location.search);
    setNext(safeReturnTo(params.get("next")));
    usernameRef.current?.focus();
  }, []);

  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = window.setInterval(() => {
      setRetryAfter((seconds) => (seconds > 0 ? seconds - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAfter]);

  const submit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || retryAfter > 0) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (response.ok) {
        // A full navigation rather than a client transition: the session is a
        // cookie the server just set, and the destination is a server component
        // that reads it.
        window.location.assign(next);
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as { detail?: unknown };
      setError(typeof payload.detail === "string"
        ? payload.detail
        : `Sign-in failed (${response.status}).`);
      const header = Number(response.headers.get("retry-after") || 0);
      if (header > 0) setRetryAfter(header);
      else {
        const match = /(\d+) seconds/.exec(typeof payload.detail === "string" ? payload.detail : "");
        if (match) setRetryAfter(Number(match[1]));
      }
    } catch {
      setError("The portal could not be reached. Check that it is running and try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, next, password, retryAfter, username]);

  return (
    <div className="gate">
      <h1>Sign in to OnTrak</h1>
      <p>
        One sign-in for the whole family: the training range, the service desk,
        identity, and estate updates. What you see depends on your role.
      </p>

      {error_ ? <div className="note note--bad" role="alert">{error_}</div> : null}

      <form onSubmit={submit} noValidate>
        <label className="field">
          <span>Username</span>
          <input
            ref={usernameRef}
            type="text"
            value={username}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            disabled={busy}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            required
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {retryAfter > 0 ? (
          <div className="note note--warn" role="status">
            Too many attempts. Try again in {retryAfter} seconds.
          </div>
        ) : null}

        <div className="actions">
          <button className="primary" type="submit"
                  disabled={busy || retryAfter > 0 || !username.trim() || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>

      {ssoEnabled ? (
        <>
          <div className="divider"><span>or</span></div>
          <a className="sso-button" href={`/api/sso/start?next=${encodeURIComponent(next)}`}>
            Sign in with {providerName}
          </a>
          <p className="faint" style={{ marginTop: 9 }}>
            Your account, groups and second factor are managed in {providerName}. The
            group you belong to is what decides your role here.
          </p>
        </>
      ) : (
        <p className="faint" style={{ marginTop: 16, marginBottom: 0 }}>
          Single sign-on is not configured for this portal, so the local account
          table — the one OnTrak Sync holds — is the way in.
        </p>
      )}
    </div>
  );
}
