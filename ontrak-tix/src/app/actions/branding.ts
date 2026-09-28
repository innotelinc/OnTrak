"use server";

/**
 * Client branding server action (M4).
 *
 * One action, because a brand is one thing: replace it or leave it alone. The
 * validation that stops a client picking an unreadable colour or an
 * injection-shaped "logo" lives in `client-branding-rules.ts`, so a form cannot
 * store what the portal could not safely render.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireActor } from "../../lib/session";
import { clientBrandingServicesFor } from "../../lib/db";

function back(to: string, message: string, kind: "flash" | "error" = "flash"): never {
  revalidatePath(to.split("?")[0] || "/clients");
  const joiner = to.includes("?") ? "&" : "?";
  redirect(`${to}${joiner}${kind}=${encodeURIComponent(message)}`);
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

/** Save the name, colour, logo and voice one client is shown in. */
export async function saveBrandingAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const clientId = text(formData, "clientId");
  if (!clientId) back("/clients", "Choose a client first.", "error");

  const result = await clientBrandingServicesFor().save(actor, clientId, {
    displayName: text(formData, "displayName"),
    accentColor: text(formData, "accentColor"),
    logoUrl: text(formData, "logoUrl"),
    supportEmail: text(formData, "supportEmail"),
    signature: text(formData, "signature"),
  });
  if (!result.ok) back("/clients", result.error, "error");

  revalidatePath("/clients");
  back("/clients", `${result.value.displayName} is now shown in ${result.value.accentColor}. Their pages and notices use it from here.`);
}
