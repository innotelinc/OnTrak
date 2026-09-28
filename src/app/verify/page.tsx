import Link from "next/link";
import type { Metadata } from "next";
import { VerifyForm } from "@/components/VerifyForm";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Card } from "@/components/ui";
import { getTranslator } from "@/lib/i18n-server";
import { COMPLETION_FORMAT, ASSURANCE_PACKET_FORMAT } from "@/lib/credentials";

export const metadata: Metadata = { title: "Verify a certificate" };

/**
 * Public verification, deliberately outside the signed-in shell: the person
 * checking a certificate is usually an auditor, an employer or an admissions
 * office, not somebody with an account here.
 */
export default async function VerifyPage() {
  const t = await getTranslator();

  return (
    <main className="relative flex min-h-dvh items-start justify-center overflow-hidden px-5 py-12">
      <div className="mesh-bg pointer-events-none absolute inset-0 opacity-70" aria-hidden />
      <div className="relative w-full max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <Logo subtitle="IT support training" />
          <ThemeToggle />
        </div>

        <Card className="animate-rise">
          <h1 className="font-display text-2xl font-semibold text-ink">{t("verify.title")}</h1>
          <p className="mt-1 mb-6 text-sm text-ink-soft">{t("verify.description")}</p>
          <VerifyForm />
        </Card>

        <Card className="mt-5">
          <h2 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">
            {t("verify.how")}
          </h2>
          <p className="mt-2 text-sm text-ink-soft">{t("verify.howBody")}</p>
          <dl className="mt-3 space-y-1.5 text-xs text-ink-faint">
            <div className="flex flex-wrap gap-2">
              <dt className="font-semibold">{t("verify.format.record")}</dt>
              <dd className="font-mono">{COMPLETION_FORMAT}</dd>
            </div>
            <div className="flex flex-wrap gap-2">
              <dt className="font-semibold">{t("verify.format.packet")}</dt>
              <dd className="font-mono">{ASSURANCE_PACKET_FORMAT}</dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-ink-soft">
            <Link href="/login" className="font-semibold text-brand hover:underline">
              {t("verify.signIn")} →
            </Link>
          </p>
        </Card>
      </div>
    </main>
  );
}
