import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { getSession } from "@/lib/auth";
import { LOCALE_COOKIE, resolveLocale } from "@/lib/i18n";

/**
 * Layout for every signed-in area.  Middleware has already screened the
 * request, but this reads the real user record so a deactivated or deleted
 * account is locked out on its very next navigation.
 */
export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect("/login");

  const store = await cookies();
  const locale = resolveLocale(store.get(LOCALE_COOKIE)?.value);

  return (
    <AppShell user={user} locale={locale}>
      {children}
    </AppShell>
  );
}
