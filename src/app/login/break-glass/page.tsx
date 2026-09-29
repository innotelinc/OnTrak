import Link from "next/link";
import type { Metadata } from "next";

import { SignInForm } from "@/components/auth/AuthForms";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Alert, Card } from "@/components/ui";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = {
  title: "Break-glass sign-in",
  // Never indexed, never linked from the sign-in screen. It is a door for the day
  // the identity provider is down, not a second front door.
  robots: { index: false, follow: false },
};

/**
 * Break-glass sign-in.
 *
 * OnTrak is single sign-on only, and this page is the one deliberate exception: a
 * local account that works when the provider does not. It exists because "the
 * identity provider is down" must not also mean "the training range is closed", and
 * it is kept unlinked and un-indexed because a fallback that is easy to reach stops
 * being a fallback and starts being how people sign in.
 *
 * Self-registration lives here too, for the same reason: creating an account means
 * choosing a local password, and anything to do with a local password belongs behind
 * the break-glass door rather than on the front page. Set
 * `NEXT_PUBLIC_ALLOW_SELF_REGISTRATION=false` to close it.
 */
export default async function BreakGlassPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const selfRegistration = (process.env.NEXT_PUBLIC_ALLOW_SELF_REGISTRATION ?? "true") !== "false";
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
          <h1 className="font-display text-2xl font-semibold text-ink">{t("auth.breakGlassTitle")}</h1>
          <p className="mt-1 mb-6 text-sm text-ink-soft">{t("auth.breakGlassIntro")}</p>

          <div className="mb-5">
            <Alert tone="amber">{t("auth.breakGlassWarning")}</Alert>
          </div>

          {error ? (
            <div className="mb-5">
              <Alert tone="danger" title={t("auth.signInFailed")}>
                {error}
              </Alert>
            </div>
          ) : null}

          <SignInForm next={next} />

          <p className="mt-6 text-xs text-ink-faint">
            <Link href="/login" className="font-semibold text-brand hover:underline">
              ← {t("auth.ssoSignIn")}
            </Link>
          </p>
        </Card>

        {selfRegistration ? (
          <p className="mt-5 text-center text-sm text-ink-soft">
            {t("auth.newStudent")}{" "}
            <Link
              href="/register"
              className="font-semibold text-brand underline decoration-brand/30 underline-offset-4 hover:decoration-brand"
            >
              {t("auth.createAccount")}
            </Link>
          </p>
        ) : null}
      </div>
    </main>
  );
}
