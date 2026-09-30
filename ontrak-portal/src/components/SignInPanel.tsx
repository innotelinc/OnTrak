"use client";

/**
 * The sign-in gate — single sign-on only.
 *
 * OnTrak is one identity layer, so this page has exactly one control on it: the
 * provider. There is deliberately no username and password form here. A second
 * way in is a second place a password can be wrong, a second place it can be
 * reused, and a second place to audit; the family's whole premise is that a person
 * is who the directory says they are.
 *
 * If the provider is not configured for this deployment the page says so plainly
 * instead of rendering a control that cannot complete — a button that fails after
 * the click is worse than an honest sentence before it. (The break-glass account
 * does exist, but only when BOTH `ONTRAK_PORTAL_ADMIN_USER` and `_PASSWORD` are set
 * on the deployment, and it is not offered here even then: it is for the day the
 * provider is down, and using it is a decision, not a convenience.)
 */

import { useEffect, useState } from "react";

import { safeReturnTo } from "@/lib/oidc-rules";

export function SignInPanel({ ssoEnabled, error }: {
  ssoEnabled: boolean;
  /** A reason handed in from the callback, shown as-is. */
  error: string | null;
}) {
  const [next, setNext] = useState("/");

  useEffect(() => {
    // Read from `location` in an effect rather than during render: the server has
    // no `location`, so computing the SSO href inline would render one value on
    // the server and another in the browser.
    const params = new URLSearchParams(window.location.search);
    setNext(safeReturnTo(params.get("next")));
    const error_ = params.get("error");
    if (error_) {
      // A refusal that arrived with the redirect stays readable in the address bar
      // for a reload or a copy into a ticket; nothing here needs the query string.
      window.history.replaceState(null, "", "/login");
    }
  }, []);

  return (
    <div className="gate">
      <h1 className="gate__mark">
        OnTrak <span>Unity</span>
      </h1>
      {error ? <div className="note note--bad" role="alert">{error}</div> : null}

      {ssoEnabled ? (
        <a className="sso-button" href={`/api/sso/start?next=${encodeURIComponent(next)}`}>
          Sign in
        </a>
      ) : (
        <div className="note note--warn" role="status">
          This deployment has no identity provider configured, so there is no way to
          sign in yet. Set <code>ONTRAK_OIDC_ISSUER</code> and{" "}
          <code>ONTRAK_OIDC_CLIENT_ID</code> and restart the portal.
        </div>
      )}
    </div>
  );
}
