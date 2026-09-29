"use client";

/**
 * The sign-in panel.
 *
 * Two ways in, and the page has to be honest about which ones are available:
 * the local username-and-password form, and **Cerulean** single sign-on. The SSO
 * button is only drawn when the API says the handshake is configured, because a
 * button that cannot complete is worse than no button — it is the difference
 * between "SSO is not set up here" and "SSO is broken".
 *
 * A note on what this form does *not* do: it never tells you whether a username
 * exists. The API answers a wrong password and an unknown account with the same
 * message, and repeating that here rather than adding a helpful hint is the whole
 * point. The lockout message is the one piece of extra information, because being
 * told "wait 30 seconds" is what stops somebody hammering it.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api";
import type { AppUser, Meta } from "@/lib/types";

export function LoginPanel({ notice, onSignedIn }: {
  /** A message from outside the form — an SSO refusal, or "the API is down". */
  notice: string | null;
  onSignedIn: (user: AppUser) => void;
}) {
  // Read in an effect rather than during render: the server has no `location`, so
  // computing this inline would render a different `href` on each side and hydrate
  // with a mismatch.
  const [next, setNext] = useState("/");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState(0);
  const [ssoError, setSsoError] = useState<string | null>(null);

  const usernameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.meta()
      .then((value) => {
        if (!cancelled) setMeta(value);
      })
      .catch((cause) => {
        if (!cancelled) setMetaError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The SSO callback redirects back here with `?sso_error=<why>` rather than
  // showing JSON, so the reason arrives as a query parameter. Read from
  // `window.location` rather than `useSearchParams` so this component does not
  // need a Suspense boundary and the login page stays statically renderable.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNext(params.get("next") || "/");
    const reason = params.get("sso_error");
    if (reason) {
      setSsoError(reason);
      // Drop it from the address bar: a refresh should not re-show a stale
      // refusal, and the URL is the last place a reason like this should linger.
      const clean = window.location.pathname + (params.get("next")
        ? `?next=${encodeURIComponent(params.get("next") as string)}` : "");
      window.history.replaceState(null, "", clean);
    }
    usernameRef.current?.focus();
  }, []);

  // The lockout counts down on screen. Without this, "try again in 300 seconds"
  // is a number nobody can act on and the next click just fails again.
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
      const result = await api.signIn(username.trim(), password);
      setPassword("");
      onSignedIn(result.user);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setError(cause.message);
      } else if (cause instanceof ApiError && cause.status === 422) {
        setError(cause.problems.join("; "));
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      // A lockout arrives as a `Retry-After` header; the browser exposes it on a
      // 401 only when the response is same-origin, and the same-origin deployment
      // is exactly the one that gets locked out behind the edge. The message is
      // the fallback, because a proxy that strips the header must not cost the
      // operator the countdown.
      if (cause instanceof ApiError && cause.retryAfter > 0) {
        setRetryAfter(cause.retryAfter);
      } else {
        const match = /(\d+) seconds/.exec(cause instanceof Error ? cause.message : "");
        if (match) setRetryAfter(Number(match[1]));
      }
    } finally {
      setBusy(false);
    }
  }, [busy, onSignedIn, password, retryAfter, username]);

  const ssoEnabled = Boolean(meta?.sso?.enabled);
  const noAccounts = meta !== null && meta.users_exist === false;

  return (
    <div className="gate">
      <h1>Ontrak Sync</h1>
      <p>
        Estate package and container updates. Sign in to review what is pending and
        decide what gets installed.
      </p>

      {notice ? <div className="note note--bad" role="alert">{notice}</div> : null}
      {ssoError ? (
        <div className="note note--bad" role="alert">
          {meta?.sso.provider ?? "Cerulean"} refused that sign-in: {ssoError}
        </div>
      ) : null}
      {metaError ? (
        <div className="note note--bad" role="alert">
          The API could not be reached, so the sign-in options cannot be read: {metaError}
        </div>
      ) : null}
      {noAccounts ? (
        <div className="note note--warn">
          This deployment has no accounts yet. The first administrator is created on
          the first start; its username and the generated password are printed in the
          API container&apos;s log (<code>docker compose logs ontrak-api</code>).
        </div>
      ) : null}

      <form onSubmit={submit} noValidate>
        <label className="field">
          <span>Username</span>
          <input
            ref={usernameRef}
            type="text"
            name="username"
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
            type={showPassword ? "text" : "password"}
            name="password"
            value={password}
            autoComplete="current-password"
            required
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
          <small>
            <label className="checkline" style={{ display: "inline-flex" }}>
              <input
                type="checkbox"
                checked={showPassword}
                onChange={(event) => setShowPassword(event.target.checked)}
              />
              show the password
            </label>
          </small>
        </label>

        {error ? (
          <div className="note note--bad" role="alert">
            {error}
            {retryAfter > 0 ? ` (${retryAfter}s)` : ""}
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
        <div className="gate__sso">
          <div className="gate__divider"><span>or</span></div>
          <a className="gate__sso-button"
             href={api.ssoStartUrl(next)}>
            Sign in with {meta?.sso.provider ?? "Cerulean"}
          </a>
          <p className="faint" style={{ marginTop: 8 }}>
            Your account, groups and second factor are managed in Cerulean.
          </p>
        </div>
      ) : meta !== null && !noAccounts ? (
        <p className="faint" style={{ marginTop: 14, marginBottom: 0 }}>
          Single sign-on is not configured for this deployment.
        </p>
      ) : null}
    </div>
  );
}
