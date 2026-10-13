import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RegisterForm } from "@/components/auth/AuthForms";
import { ThemeToggle } from "@/components/ThemeToggle";
import { getTranslator } from "@/lib/i18n-server";
import { ItsGateMark } from "@/components/Logo";

export const metadata: Metadata = { title: "Create an account" };

const ITS_MARK = ItsGateMark();

export default async function RegisterPage() {
  const selfRegistration = (process.env.NEXT_PUBLIC_ALLOW_SELF_REGISTRATION ?? "true") !== "false";
  if (!selfRegistration) redirect("/login");

  const t = await getTranslator();

  return (
    <div className="gate-wrap">
      <div className="gate">
        <div className="gate__tools">
          <ThemeToggle />
        </div>

        <div className="gate__mark-wrap">
          {ITS_MARK}
          <h1 className="gate__mark">
            OnTrak <span>IT Support Training</span>
          </h1>
        </div>

        <h2 className="gate__title">{t("auth.startTraining")}</h2>
        <p className="text-sm text-ink-soft m-0">{t("auth.registerIntro")}</p>

        <RegisterForm showJoinCode />

        <p className="text-center text-sm text-ink-soft">
          {t("auth.alreadyEnrolled")}{" "}
          <Link href="/login" className="font-semibold text-brand underline decoration-brand/30 underline-offset-4 hover:decoration-brand">
            {t("auth.signIn")}
          </Link>
        </p>
      </div>
    </div>
  );
}
