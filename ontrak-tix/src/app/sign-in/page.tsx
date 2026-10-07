import type { Metadata } from "next";

import { ThemeToggle } from "../../components/ThemeToggle";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Sign-in: single sign-on, and nothing else.
 *
 * The family's front door, drawn the same way here as in OnTrak Unity: the
 * product's name and the one control that hands the browser to the provider.
 * There is deliberately no email-and-password form. A second way in is a second
 * place a password can be wrong, a second place it can be reused, and a second
 * place to audit; the whole premise of the Network is that a person is who the
 * directory says they are.
 *
 * The break-glass account still exists for the day the provider is down, at
 * `/sign-in/break-glass` — deliberately not linked from here, because using it is a
 * decision rather than a convenience.
 */

/**
 * The workspace a deployment signs in against when nobody types one.
 *
 * Empty in a multi-tenant install, where the slug is the whole point; set to the
 * single desk's slug (`ONTRAK_TIX_DEFAULT_TENANT=acme`) where asking a person for an
 * internal identifier is friction with no security value — the tenant it resolves to
 * is the same one every time, and `/api/sso/start` still refuses a workspace that
 * does not exist.
 */
const defaultTenant = (process.env.ONTRAK_TIX_DEFAULT_TENANT ?? "").trim();

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const startHref = defaultTenant
    ? `/api/sso/start?tenant=${encodeURIComponent(defaultTenant)}`
    : "/api/sso/start";

  return (
    <div className="gate-wrap">
      <div className="gate">
        <div className="gate__tools">
          <ThemeToggle />
        </div>

        <h1 className="gate__mark">
          OnTrak <span>Tix</span>
        </h1>

        {error ? (
          <div className="note note--bad" role="alert">
            {error}
          </div>
        ) : null}

        {/* An anchor, not a button: the handshake is a browser navigation, and
            fetching it is what breaks it. */}
        {defaultTenant ? (
          <a className="sso-button" href={startHref}>
            Sign in
          </a>
        ) : (
          // Multi-tenant: the workspace is what a person actually knows, and only it
          // can resolve to the right IdP. Still SSO — never a password.
          <form method="get" action="/api/sso/start" className="flex flex-col gap-3 text-left">
            <label className="ot-field text-left">
              <span>Workspace</span>
              <input
                name="tenant"
                placeholder="acme"
                autoComplete="organization"
                required
                className="ot-input"
              />
            </label>
            <button type="submit" className="sso-button">
              Continue
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
