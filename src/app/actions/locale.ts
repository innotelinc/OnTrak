"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { safeRelativePath } from "@/lib/auth-rules";
import { LOCALE_COOKIE, resolveLocale } from "@/lib/i18n";

/** Persist the chosen locale and return the user to where they were. */
export async function setLocale(formData: FormData): Promise<void> {
  const locale = resolveLocale(formData.get("locale"));

  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });

  // Reuse the same-site redirect guard used by the auth flows.
  redirect(safeRelativePath(formData.get("back")) ?? "/");
}
