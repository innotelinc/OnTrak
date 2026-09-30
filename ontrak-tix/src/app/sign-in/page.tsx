import type { Metadata } from "next";

import { ThemeToggle } from "../../components/ThemeToggle";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Sign-in: single sign-on, and nothing else.
 *
 * OnTrak is one identity layer, so this screen has exactly one control on it: the
 * provider. There is deliberately no email-and-password form here. A second way in
 * is a second place a password can be wrong, a second place it can be reused, and a
 * second place to audit; the whole premise of the Network is that a person is who
 * the directory says they are.
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
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6 py-10">
      <div className="flex justify-end">
        <ThemeToggle />
      </div>

      <div className="card-surface rounded-xl2 p-8 text-center">
        <h1 className="font-display text-2xl font-semibold text-ink">
          OnTrak <span className="text-brand">Tix</span>
        </h1>
        {error ? (
          <p role="alert" className="ot-note ot-note--bad mt-5 text-left">
            {error}
          </p>
        ) : null}

        {/* An anchor, not a button: the handshake is a browser navigation, and
            fetching it is what breaks it. */}
        {defaultTenant ? (
          <a
            href={startHref}
            className="mt-6 block rounded-full bg-brand px-4 py-2.5 text-sm font-semibold text-brand-ink hover:opacity-95"
          >
            Sign in
          </a>
        ) : (
          // Multi-tenant: the workspace is what a person actually knows, and only it
          // can resolve to the right IdP. Still SSO — never a password.
          <form method="get" action="/api/sso/start" className="mt-6 space-y-3 text-left">
            <label className="block text-sm font-medium text-ink">
              Workspace
              <input
                name="tenant"
                placeholder="acme"
                autoComplete="organization"
                required
                className="ot-input mt-1"
              />
            </label>
            <button
              type="submit"
              className="w-full rounded-full bg-brand px-4 py-2.5 text-sm font-semibold text-brand-ink hover:opacity-95"
            >
              Continue
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
