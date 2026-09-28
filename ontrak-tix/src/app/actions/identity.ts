"use server";

/**
 * Identity admin server action (M2).
 *
 * The form's role mappings travel as text and are parsed (and validated) here,
 * not trusted from the browser; the service then validates the whole connection
 * again before it is stored. So a crafted form can fail, but it cannot store a
 * connection the rules would refuse.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { ROLES, type Role } from "../../lib/access-rules";
import { requireActor } from "../../lib/session";
import { identityServicesFor } from "../../lib/db";
import { IDENTITY_PROTOCOLS, parseRoleMappings, splitList, type IdentityProtocol } from "../../lib/identity-rules";

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function fail(message: string): never {
  redirect(`/admin/identity?error=${encodeURIComponent(message)}`);
}

export async function saveIdentityConnectionAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  const parsed = parseRoleMappings(String(formData.get("roleMappings") ?? ""));
  if (parsed.errors.length > 0) fail(parsed.errors[0]);

  const result = await identityServicesFor().configure(actor, {
    protocol: pick<IdentityProtocol>(formData.get("protocol"), IDENTITY_PROTOCOLS, "OIDC"),
    issuer: text(formData, "issuer"),
    clientId: text(formData, "clientId"),
    scopes: splitList(String(formData.get("scopes") ?? "")),
    allowedDomains: splitList(String(formData.get("allowedDomains") ?? "")),
    defaultRole: pick<Role>(formData.get("defaultRole"), ROLES, "REQUESTER"),
    roleMappings: parsed.mappings,
    mfaRequired: formData.get("mfaRequired") !== null,
    scimEnabled: formData.get("scimEnabled") !== null,
  });
  if (!result.ok) fail(result.error);

  revalidatePath("/admin/identity");
  redirect("/admin/identity?flash=Identity+connection+saved");
}
