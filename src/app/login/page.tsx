import type { Metadata } from "next";

import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Alert, Card } from "@/components/ui";
import { activeSsoConfig } from "@/lib/oidc-rules";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Sign-in: single sign-on, and nothing else.
 *
 * OnTrak is one identity layer, so this page has exactly one control on it: the
 * provider. The email-and-password form that used to sit underneath it moved to
 * `/login/break-glass` — a local account is still the answer on the day the
 * provider is down, but it is not the front door, and it is not linked from here.
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
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-5 py-12">
      <div className="mesh-bg pointer-events-none absolute inset-0 opacity-70" aria-hidden />
      <div className="relative w-full max-w-md">
        <div className="mb-6 flex items-center justify-between">
          <Logo subtitle="IT support training" />
          <ThemeToggle />
        </div>

        <Card className="animate-rise">
          <h1 className="font-display text-2xl font-semibold text-ink">{t("auth.welcomeBack")}</h1>
          <p className="mt-1 mb-6 text-sm text-ink-soft">{t("auth.signInIntro")}</p>

          {error ? (
            <div className="mb-5">
              <Alert tone="danger" title={t("auth.signInFailed")}>
                {error}
              </Alert>
            </div>
          ) : null}

          {sso ? (
            <>
              {/* An anchor, not a button: the handshake is a browser navigation,
                  and fetching it is what breaks it. */}
              <a
                href={`/api/sso/start${next ? `?next=${encodeURIComponent(next)}` : ""}`}
                className="flex w-full items-center justify-center rounded-xl bg-brand px-4 py-3 text-sm font-semibold text-brand-ink transition hover:opacity-95"
              >
                {t("auth.ssoSignIn")}
              </a>
              <p className="mt-3 text-center text-xs text-ink-soft">{t("auth.ssoIntro")}</p>
            </>
          ) : (
            <Alert tone="amber" title={t("auth.ssoMissing")}>
              {t("auth.ssoMissingBody")}
            </Alert>
          )}
        </Card>
      </div>
    </main>
  );
}
