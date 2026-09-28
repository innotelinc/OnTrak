import Link from "next/link";
import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/AuthForms";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Card } from "@/components/ui";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
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
          <h1 className="font-display text-2xl font-semibold text-ink">{t("auth.welcomeBack")}</h1>
          <p className="mt-1 mb-6 text-sm text-ink-soft">{t("auth.signInIntro")}</p>
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
