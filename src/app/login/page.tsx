import type { Metadata } from "next";

import { ThemeToggle } from "@/components/ThemeToggle";
import { activeSsoConfig } from "@/lib/oidc-rules";
import { getTranslator } from "@/lib/i18n-server";
import { ItsGateMark, ItsMastheadMark } from "@/components/Logo";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Sign-in: single sign-on, and nothing else.
 *
 * The family's front door, drawn the same way here as in OnTrak Unity: the masthead
 * that says which product this is and where it is reached, the mark and the name, and
 * the one control that hands the browser to the provider. There is deliberately no
 * email-and-password form. A second way in is a second place a password can be wrong,
 * a second place it can be reused, and a second place to audit; the whole premise of
 * the Network is that a person is who the directory says they are.
 *
 * The break-glass account still exists for the day the provider is down, at
 * `/login/break-glass` — deliberately not linked from here, because using it is a
 * decision rather than a convenience.
 *
 * The button is offered only when this deployment can actually complete a handshake; a
 * button that cannot work is worse than no button. The check reads the environment on
 * every request, so enabling single sign-on needs a restart rather than a rebuild.
 */

/**
 * The family's own address, printed under the product's name.
 *
 * `ONTRAK_PORTAL_BASE_DOMAIN` is the portal's variable for the family's name — the
 * same one its product tiles link against (`capabilities.ts`) and the same default —
 * and it is read the same way here so every front door reads alike. What it is *not*
 * is this container's address: behind a proxy that would be `0.0.0.0:3000`, which is
 * a worse thing to print than the family's name.
 */
const FAMILY_DOMAIN = (process.env.ONTRAK_PORTAL_BASE_DOMAIN ?? "ontrak.innotel.us")
  .trim()
  .replace(/^["']|["']$/g, "")
  .replace(/\.+$/, "");

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const sso = activeSsoConfig();
  const t = await getTranslator();

  return (
    <div className="page">
      <header className="masthead">
        <a className="masthead__brand" href="/">
          <ItsMastheadMark />
          <strong>OnTrak IT Support Training</strong>
          <span>{FAMILY_DOMAIN}</span>
        </a>
        <div className="masthead__tools">
          <ThemeToggle />
        </div>
      </header>

      <main className="page__main">
        <div className="gate">
          <div className="gate__mark-wrap">
            <ItsGateMark />
            <h1 className="gate__mark">
              OnTrak <span>IT Support Training</span>
            </h1>
          </div>

          {error ? (
            <div className="ot-note ot-note--bad text-left" role="alert">
              {error}
            </div>
          ) : null}

          {sso ? (
            <a
              className="sso-button"
              href={`/api/sso/start${next ? `?next=${encodeURIComponent(next)}` : ""}`}
            >
              {t("auth.ssoSignIn")}
            </a>
          ) : (
            <div className="ot-note ot-note--warn text-left" role="status">
              <strong>{t("auth.ssoMissing")}</strong>
              <p className="m-0 mt-1">{t("auth.ssoMissingBody")}</p>
            </div>
          )}
        </div>
      </main>

      <footer className="footer">
        <span>OnTrak IT Support Training</span>
      </footer>
    </div>
  );
}
