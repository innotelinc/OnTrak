import type { Metadata } from "next";

import { signInAction } from "../../actions/auth";

export const metadata: Metadata = {
  title: "Break-glass sign-in",
  // Never indexed, never linked from the sign-in screen. It is a door for the day
  // the identity provider is down, not a second front door.
  robots: { index: false, follow: false },
};

/**
 * Break-glass sign-in.
 *
 * The family is single sign-on only, and this page is the single deliberate
 * exception: a local account that works when the provider does not. It exists
 * because "the IdP is down" must not also mean "the desk cannot see its tickets",
 * and it is kept unlinked and un-indexed because a fallback that is easy to reach
 * stops being a fallback and starts being how people sign in.
 *
 * Set `ONTRAK_TIX_ALLOW_LOCAL_SIGN_IN=0` to close it entirely.
 */
export default async function BreakGlassPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const allowed = (process.env.ONTRAK_TIX_ALLOW_LOCAL_SIGN_IN ?? "1") !== "0";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6 py-10">
      <div className="card-surface rounded-xl2 p-8">
        <h1 className="font-display text-xl font-semibold text-ink">Break-glass sign-in</h1>
        <p className="mt-1.5 text-sm text-ink-soft">
          OnTrak Tix is single sign-on only. This screen is the local fallback for the day the identity provider cannot
          be reached.
        </p>

        {!allowed ? (
          <p role="alert" className="ot-note ot-note--bad mt-5">
            Local sign-in is disabled on this deployment (<code className="font-mono">ONTRAK_TIX_ALLOW_LOCAL_SIGN_IN=0</code>).
            Use single sign-on.
          </p>
        ) : (
          <>
            <p className="ot-note ot-note--warn mt-5">
              Signing in here is not the normal path. If the provider is up, close this tab and sign in with single
              sign-on — every use of this page is audited.
            </p>

            {error ? (
              <p role="alert" className="ot-note ot-note--bad mt-4">
                {error}
              </p>
            ) : null}

            <form action={signInAction} className="mt-5 space-y-4">
              <label className="block text-sm font-medium text-ink">
                Email
                <input
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  className="ot-input mt-1"
                />
              </label>

              <label className="block text-sm font-medium text-ink">
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  className="ot-input mt-1"
                />
              </label>

              <button
                type="submit"
                className="w-full rounded-full border border-line-strong bg-surface-muted px-4 py-2 text-sm font-semibold text-ink hover:border-brand-ring"
              >
                Sign in locally
              </button>
            </form>
          </>
        )}

        <p className="mt-6 text-xs text-ink-faint">
          <a href="/sign-in" className="hover:text-brand">
            ← Back to single sign-on
          </a>
        </p>
      </div>
    </main>
  );
}
