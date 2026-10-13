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
 * Sign-in: single sign-on for the one desk, and nothing else.
 *
 * This deployment is single-desk, so the sign-in page has exactly one control:
 * the identity provider. There is no workspace to type, because there is only one.
 * There is deliberately no email-and-password form. A second way in is a second
 * place a password can be wrong, a second place it can be reused, and a second
 * place to audit; the whole premise of the Network is that a person is who the
 * directory says they are.
 *
 * The break-glass account still exists for the day the provider is down, at
 * `/sign-in/break-glass` — deliberately not linked from here, because using it is
 * a decision rather than a convenience.
 */

/** The OnTrak Tix mark: a ticket stub with a check — the desk's registry, plain and
 * simple. Flat, 48×48, brand-toned, the same style every OnTrak product carries on
 * its login. */
const TIX_MARK =
  <svg
    className="gate__mark-svg"
    viewBox="0 0 48 48"
    role="img"
    aria-label="OnTrak Tix"
    width="44"
    height="44"
  >
    <defs>
      <linearGradient id="tix-mark" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="var(--brand)" />
        <stop offset="100%" stopColor="var(--tone-tix)" />
      </linearGradient>
    </defs>
    <path
      d="M10 11 h15 a4 4 0 0 1 4 4 v20 a4 4 0 0 1 -4 4 h-12 a4 4 0 0 1 -4 -4 v-7 a4 4 0 0 1 4 -4 h7 l5 -6 v-6 z"
      fill="url(#tix-mark)"
    />
    <path
      d="M10 11 V8 a3 3 0 0 1 3 -3 h13 a3 3 0 0 1 3 3 v3"
      fill="none"
      stroke="var(--brand-ink)"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M30 24 l3.5 3.5 l-3.5 3.5"
      fill="none"
      stroke="var(--brand-ink)"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="31.5" cy="22.5" r="1.7" fill="var(--brand-ink)" />
  </svg>;

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;

  return (
    <div className="gate-wrap">
      <div className="gate">
        <div className="gate__mark-wrap">
          {TIX_MARK}
          <h1 className="gate__mark">
            OnTrak <span>Tix</span>
          </h1>
        </div>

        <div className="gate__tools">
          <ThemeToggle />
        </div>

        {error ? (
          <div className="note note--bad" role="alert">
            {error}
          </div>
        ) : null}

        {/* An anchor, not a button: the handshake is a browser navigation, and
            fetching it is what breaks it. */}
        <a className="sso-button" href="/api/sso/start">
          Sign in
        </a>
      </div>
    </div>
  );
}
