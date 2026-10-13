import type { Metadata } from "next";

import { ThemeToggle } from "../../components/ThemeToggle";

/**
 * The tab says which product this is, not which page.
 *
 * Every other OnTrak front door names its product in the title bar, and this one used
 * to name the form instead: "Sign in". A person with the desk, the console and the
 * training range open in three tabs could not tell which was which without reading
 * each one — the page already says "Sign in" in the one control it has.
 */
export const metadata: Metadata = { title: "OnTrak Tix" };

/**
 * Sign-in: single sign-on for the one desk, and nothing else.
 *
 * The family's front door, drawn the same way here as in OnTrak Unity: the masthead
 * that says which product this is and where it is reached, the mark and the name, and
 * the one control that hands the browser to the provider. This deployment is
 * single-desk, so there is no workspace to type — there is only one.
 *
 * There is deliberately no email-and-password form. A second way in is a second place
 * a password can be wrong, a second place it can be reused, and a second place to
 * audit; the whole premise of the Network is that a person is who the directory says
 * they are.
 *
 * The break-glass account still exists for the day the provider is down, at
 * `/sign-in/break-glass` — deliberately not linked from here, because using it is a
 * decision rather than a convenience.
 */

/**
 * The family's own address, printed under the product's name.
 *
 * `ONTRAK_PORTAL_BASE_DOMAIN` is the portal's variable for the family's name — the
 * same one its product tiles link against — and it is read the same way here so every
 * front door reads alike. What it is *not* is this container's address: behind a proxy
 * that would be `127.0.0.1:3001`, which is a worse thing to print than the family's
 * name.
 */
const FAMILY_DOMAIN = (process.env.ONTRAK_PORTAL_BASE_DOMAIN ?? "ontrak.innotel.us")
  .trim()
  .replace(/^["']|["']$/g, "")
  .replace(/\.+$/, "");

/**
 * The OnTrak Tix mark: the family's shield with a conversation in it.
 *
 * One silhouette is shared by every product — the shield — and each carries a single
 * stroke of its own inside it. The desk's stroke is the conversation, because a ticket
 * is a conversation somebody has to answer. `--tone-tix` is where the gradient lands.
 */
const SHIELD = "M24 4.5 L41 12 V27 C41 37.4 34 43 24 44.5 C14 43 7 37.4 7 27 V12 Z";
const BUBBLE =
  "M15.5 19 h17 a3.5 3.5 0 0 1 3.5 3.5 v6 a3.5 3.5 0 0 1 -3.5 3.5 h-8.5 l-5.5 4.5 v-4.5 h-3 a3.5 3.5 0 0 1 -3.5 -3.5 v-6 a3.5 3.5 0 0 1 3.5 -3.5 z";

/**
 * The shield and the product's stroke.
 *
 * `gradientId` is a parameter rather than a constant because the mark is drawn twice
 * on this page — in the masthead and on the gate — and two elements with the same `id`
 * is a document that only works because the browser picked the first one. `label` is
 * the other half of that: the gate's mark is the only thing naming the product there,
 * so it is labelled; the masthead's sits beside the name in text, so it is decoration.
 */
function Shield({
  gradientId,
  className,
  label,
}: {
  gradientId: string;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--brand)" />
          <stop offset="100%" stopColor="var(--tone-tix)" />
        </linearGradient>
      </defs>
      <path d={SHIELD} fill={`url(#${gradientId})`} />
      <path
        d={BUBBLE}
        fill="none"
        stroke="var(--brand-ink)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;

  return (
    <div className="page">
      <header className="masthead">
        <a className="masthead__brand" href="/">
          <Shield gradientId="tix-masthead-mark" className="masthead__mark" />
          <strong>OnTrak Tix</strong>
          <span>{FAMILY_DOMAIN}</span>
        </a>
        <div className="masthead__tools">
          <ThemeToggle />
        </div>
      </header>

      <main className="page__main">
        <div className="gate">
          <div className="gate__mark-wrap">
            <Shield gradientId="tix-gate-mark" className="gate__mark-svg" label="OnTrak Tix" />
            <h1 className="gate__mark">
              OnTrak <span>Tix</span>
            </h1>
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
      </main>

      <footer className="footer">
        <span>OnTrak Tix</span>
      </footer>
    </div>
  );
}
