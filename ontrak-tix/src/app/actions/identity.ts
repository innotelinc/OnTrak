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
import { identityServicesFor, scimSyncServicesFor } from "../../lib/db";
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

function flash(message: string): never {
  redirect(`/admin/identity?flash=${encodeURIComponent(message)}`);
}

/**
 * Push every account this tenant holds to the identity provider (outbound SCIM).
 *
 * The service decides what needs writing and records each applied change on the
 * tenant's hash chain; this action only turns the outcome into one sentence a
 * person can act on. A failed run reports the *first* provider refusal by name —
 * "the sync failed" is not something anybody can fix.
 */
export async function pushPeopleToProviderAction(): Promise<void> {
  const actor = await requireActor();
  const result = await scimSyncServicesFor().push(actor);
  if (!result.ok) fail(result.error);

  const outcome = result.value;
  const summary = [
    `${outcome.total} account${outcome.total === 1 ? "" : "s"} checked`,
    outcome.created > 0 ? `${outcome.created} created` : null,
    outcome.updated > 0 ? `${outcome.updated} updated` : null,
    outcome.deactivated > 0 ? `${outcome.deactivated} switched off` : null,
    outcome.unchanged > 0 ? `${outcome.unchanged} already matched` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

  if (outcome.failures.length > 0) {
    const first = outcome.failures[0];
    const rest = outcome.failures.length > 1 ? ` (and ${outcome.failures.length - 1} more)` : "";
    fail(`${summary}. ${first.reason} — ${first.email}${rest}`);
  }

  revalidatePath("/admin/identity");
  flash(`${summary}.`);
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
