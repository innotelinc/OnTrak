"use server";

/**
 * Granular role server actions (M6).
 *
 * Every action starts from `requireActor()` and hands the work to `RoleService`, which owns the
 * permission (`user:manage`), the validation, the guard against stranding the desk and the audit
 * event. Nothing is decided here — this file reads a form and turns a refusal into a sentence on
 * the page, which is the same shape `forms.ts` and `integrations.ts` already have.
 *
 * The permissions arrive as one repeated checkbox name rather than as a delimited string, so a
 * permission whose label contains a comma is not a parsing question, and *nothing checked* is
 * unambiguous.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { roleServicesFor } from "../../lib/db";
import { requireActor } from "../../lib/session";
import type { Role } from "../../lib/access-rules";

const ROLES_PATH = "/admin/roles";

function back(to: string, message: string, kind: "flash" | "error" = "flash"): never {
  revalidatePath(to.split("?")[0] || ROLES_PATH);
  const joiner = to.includes("?") ? "&" : "?";
  redirect(`${to}${joiner}${kind}=${encodeURIComponent(message)}`);
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

/** Define a role, or edit one. The key is only read when the role is new. */
export async function saveRoleAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const roleId = text(formData, "roleId") || null;

  const result = await roleServicesFor().save(
    actor,
    {
      key: text(formData, "key"),
      name: text(formData, "name"),
      description: text(formData, "description") || null,
      baseRole: text(formData, "baseRole") as Role,
      permissions: formData.getAll("permissions").map(String),
    },
    roleId,
  );

  if (!result.ok) back(roleId ? `${ROLES_PATH}?edit=${roleId}` : ROLES_PATH, result.error, "error");
  back(ROLES_PATH, `Saved “${result.value.name}”.`);
}

/**
 * Archive a role.
 *
 * Not a delete: its holders fall back to their built-in role and every audit entry that named it
 * still resolves, so the sentence says that rather than "deleted".
 */
export async function archiveRoleAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const roleId = text(formData, "roleId");

  const result = await roleServicesFor().archive(actor, roleId);
  if (!result.ok) back(ROLES_PATH, result.error, "error");
  back(
    ROLES_PATH,
    `“${result.value.name}” is archived. Everybody who held it is back on their built-in role.`,
  );
}

/** Hand a role to somebody (`roleId` empty) or take one away. */
export async function assignRoleAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const userId = text(formData, "userId");
  const roleId = text(formData, "roleId") || null;

  const result = await roleServicesFor().assign(actor, userId, roleId);
  if (!result.ok) back(ROLES_PATH, result.error, "error");
  back(ROLES_PATH, roleId ? "That role is in force now." : "That person is back on their built-in role.");
}
