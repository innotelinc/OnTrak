import type { Metadata } from "next";

import { ThemeToggle } from "@/components/ThemeToggle";
import { activeSsoConfig } from "@/lib/oidc-rules";
import { getTranslator } from "@/lib/i18n-server";

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
 * `/login/break-glass` — deliberately not linked from here, because using it is a
 * decision rather than a convenience.
 *
 * The button is offered only when this deployment can actually complete a
 * handshake; a button that cannot work is worse than no button. The check reads the
 * environment on every request, so enabling single sign-on needs a restart rather
 * than a rebuild.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const sso = activeSsoConfig();
  const t = await getTranslator();

  return (
    <div className="gate-wrap">
      <div className="gate">
        <div className="gate__tools">
          <ThemeToggle />
        </div>

        <h1 className="gate__mark">
          OnTrak <span>IT Support Training</span>
        </h1>

        {error ? (
          <div className="ot-note ot-note--bad text-left" role="alert">
            {error}
          </div>
        ) : null}

        {sso ? (
          <>
            {/* An anchor, not a button: the handshake is a browser navigation, and
                fetching it is what breaks it. */}
            <a
              className="sso-button"
              href={`/api/sso/start${next ? `?next=${encodeURIComponent(next)}` : ""}`}
            >
              {t("auth.ssoSignIn")}
            </a>
            <p className="ot-muted m-0 text-[12.5px]">{t("auth.ssoIntro")}</p>
          </>
        ) : (
          <div className="ot-note ot-note--warn text-left" role="status">
            <strong>{t("auth.ssoMissing")}</strong>
            <p className="m-0 mt-1">{t("auth.ssoMissingBody")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
