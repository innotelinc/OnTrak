import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RegisterForm } from "@/components/auth/AuthForms";
import { ThemeToggle } from "@/components/ThemeToggle";
import { getTranslator } from "@/lib/i18n-server";
import { ItsGateMark, ItsMastheadMark } from "@/components/Logo";

export const metadata: Metadata = { title: "Enroll" };

/** The family's own address — see the note in `app/login/page.tsx`. */
const FAMILY_DOMAIN = (process.env.ONTRAK_PORTAL_BASE_DOMAIN ?? "ontrak.innotel.us")
  .trim()
  .replace(/^["']|["']$/g, "")
  .replace(/\.+$/, "");

export default async function RegisterPage() {
  const selfRegistration = (process.env.NEXT_PUBLIC_ALLOW_SELF_REGISTRATION ?? "true") !== "false";
  if (!selfRegistration) redirect("/login");

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
      </main>

      <footer className="footer">
        <span>OnTrak IT Support Training</span>
      </footer>
    </div>
  );
}
