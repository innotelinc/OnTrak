import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RegisterForm } from "@/components/auth/AuthForms";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Alert, Card } from "@/components/ui";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Create an account" };

export default async function RegisterPage() {
  const selfRegistration = (process.env.NEXT_PUBLIC_ALLOW_SELF_REGISTRATION ?? "true") !== "false";
  if (!selfRegistration) redirect("/login");

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
          <h1 className="font-display text-2xl font-semibold text-ink">{t("auth.startTraining")}</h1>
          <p className="mt-1 mb-6 text-sm text-ink-soft">{t("auth.registerIntro")}</p>

          <RegisterForm showJoinCode />

          <div className="mt-6">
            <Alert tone="teal" title={t("auth.whatYouGet")}>
              {t("auth.whatYouGetBody")}
            </Alert>
          </div>
        </Card>

        <p className="mt-5 text-center text-sm text-ink-soft">
          {t("auth.alreadyEnrolled")}{" "}
          <Link href="/login" className="font-semibold text-brand underline decoration-brand/30 underline-offset-4 hover:decoration-brand">
            {t("auth.signIn")}
          </Link>
        </p>
      </div>
    </main>
  );
}
