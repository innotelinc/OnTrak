import type { Metadata } from "next";

import { signInAction } from "../actions/auth";

export const metadata: Metadata = { title: "Sign in" };

/**
 * The workspace a deployment signs in against when nobody types one.
 *
 * Empty in a multi-tenant install, where the slug is the whole point; set to the
 * single desk's slug (`ONTRAK_TIX_DEFAULT_TENANT=acme`) where asking a person for
 * an internal identifier is friction with no security value — the tenant it
 * resolves to is the same one every time, and `/api/sso/start` still refuses a
 * workspace that does not exist.
 */
const defaultTenant = (process.env.ONTRAK_TIX_DEFAULT_TENANT ?? "").trim();

/**
 * Local sign-in: email and password against the seeded accounts.
 *
 * This is the standalone fallback; at M2 the same session is issued after an
 * OIDC/SAML handshake with the OnTrak Sentinel IdP, so the rest of the app never
 * learns which one was used.
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-ink">
          OnTrak <span className="text-brand">Tix</span>
        </h1>
        <p className="mt-1 text-sm text-ink-soft">Sign in to the service desk.</p>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
          {error}
        </p>
      ) : null}

      <form action={signInAction} className="space-y-4 rounded-xl2 border border-line bg-surface p-5">
        <label className="block text-sm font-medium text-ink">
          Email
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>

        <label className="block text-sm font-medium text-ink">
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>

        <button type="submit" className="w-full rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white">
          Sign in
        </button>
      </form>

      <p className="text-center text-xs font-semibold text-ink-faint">or</p>

      {/*
        Single sign-on starts with the workspace, because that is what a person
        knows. The slug resolves to a tenant, and only then to that tenant's IdP.
        A one-desk deployment — which is most of them — names its workspace here
        instead, so the button works without the person having to be told a slug
        that only exists to keep a multi-tenant install honest.
      */}
      <form method="get" action="/api/sso/start" className="space-y-3 rounded-xl2 border border-line bg-surface p-5">
        <h2 className="text-sm font-semibold text-ink">Single sign-on</h2>
        <label className="block text-sm font-medium text-ink">
          Workspace
          <input
            name="tenant"
            placeholder="acme"
            autoComplete="organization"
            defaultValue={defaultTenant}
            className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>
        <button type="submit" className="w-full rounded-full border border-brand px-4 py-2 text-sm font-semibold text-brand">
          Continue with SSO
        </button>
      </form>

      <p className="text-xs text-ink-faint">
        Seeded accounts (run <code className="font-mono">npm run db:seed</code>): admin@acme.test, dispatcher@acme.test,
        agent@acme.test and requester@acme.test — all with the password <code className="font-mono">ChangeMe123</code>.
      </p>
    </main>
  );
}
