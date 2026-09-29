import Link from "next/link";
import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/AuthForms";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Card } from "@/components/ui";
import { activeSsoConfig } from "@/lib/oidc-rules";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const selfRegistration = (process.env.NEXT_PUBLIC_ALLOW_SELF_REGISTRATION ?? "true") !== "false";
  // Single sign-on is offered only when this deployment can actually complete a
  // handshake — a button that cannot work is worse than no button. The check reads
  // the environment on every request, so enabling it needs a restart rather than a
  // rebuild.
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
            <p
              role="alert"
              className="mb-5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300"
            >
              {error}
            </p>
          ) : null}

          {sso ? (
            <div className="mb-6">
              <a
                href={`/api/sso/start${next ? `?next=${encodeURIComponent(next)}` : ""}`}
                className="flex w-full items-center justify-center rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-ink transition hover:border-brand/40 hover:text-brand"
              >
                {t("auth.ssoSignIn")}
              </a>
              <p className="mt-2 text-center text-xs text-ink-soft">{t("auth.ssoIntro")}</p>
              <div className="mt-5 flex items-center gap-3" aria-hidden>
                <span className="h-px flex-1 bg-line" />
                <span className="text-xs uppercase tracking-wide text-ink-soft">{t("auth.or")}</span>
                <span className="h-px flex-1 bg-line" />
              </div>
            </div>
          ) : null}

          <SignInForm next={next} />
        </Card>

        {selfRegistration ? (
          <p className="mt-5 text-center text-sm text-ink-soft">
            {t("auth.newStudent")}{" "}
            <Link href="/register" className="font-semibold text-brand underline decoration-brand/30 underline-offset-4 hover:decoration-brand">
              {t("auth.createAccount")}
            </Link>
          </p>
        ) : null}
      </div>
    </main>
  );
}
