"use server";

/**
 * Changing somebody's role.
 *
 * Two rules, and both of them are about not locking a deployment out of itself:
 *
 *   * **Only an ADMIN may do this.** The check is here, in the action, and not
 *     only on the page: a page is a thing you can stop rendering, an action is a
 *     thing you can POST to. The role that is checked is the one on the signed
 *     session, which came from a verified assertion — not a form field.
 *   * **An administrator cannot demote or deactivate themselves here.** Sync
 *     already refuses to remove its *last* administrator, which covers the Network;
 *     this covers the smaller, far more likely mistake of an administrator taking
 *     away their own access while reading their own row. Changing your own role is
 *     something to do as somebody else.
 *
 * The role is written to OnTrak Sync's account table, because that is where a
 * local role lives — the one thing Sync owns on the family's behalf. A role that
 * arrives with a Cerulean assertion is not written here at all: it comes from the
 * directory group on every sign-in, which is why the page also shows the mapping.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { asRole } from "@/lib/portal-rules";
import { readSession } from "@/lib/session";
import { updateSyncUser } from "@/lib/sync-client";

const WHOLE_LINE = /[\r\n]/;

/**
 * Whether the row being changed is the one the administrator is signed in as.
 *
 * Compared on the directory address — the only fact the session and the account
 * table both hold — so a person who changed their display name is still protected
 * from switching themselves off.
 */
function isSelf(sessionEmail: string, rowEmail: string): boolean {
  return Boolean(sessionEmail) && sessionEmail.trim().toLowerCase() === rowEmail.trim().toLowerCase();
}

function back(notice?: string, error?: string): never {
  const params = new URLSearchParams();
  if (notice) params.set("notice", notice.replace(WHOLE_LINE, " "));
  if (error) params.set("error", error.replace(WHOLE_LINE, " "));
  redirect(`/admin/people${params.size ? `?${params.toString()}` : ""}`);
}

export async function setRole(formData: FormData): Promise<void> {
  const session = await readSession();
  if (!session || session.role !== "ADMIN") back(undefined, "Only an administrator can change a role.");

  const id = Number(formData.get("id") ?? 0);
  const username = String(formData.get("username") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const role = asRole(formData.get("role"), session.role);
  if (!Number.isFinite(id) || id <= 0) back(undefined, "That row had no account id.");

  if (isSelf(session.email, email)) {
    back(undefined, "That is your own account — ask another administrator to change it.");
  }

  const result = await updateSyncUser(id, { role });
  revalidatePath("/admin/people");
  if (!result.ok) back(undefined, result.reason ?? "The change was refused.");
  back(`${username || "That account"} is now ${role}.`);
}

export async function setActive(formData: FormData): Promise<void> {
  const session = await readSession();
  if (!session || session.role !== "ADMIN") back(undefined, "Only an administrator can do that.");

  const id = Number(formData.get("id") ?? 0);
  const username = String(formData.get("username") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const active = formData.get("active") === "true";
  if (!Number.isFinite(id) || id <= 0) back(undefined, "That row had no account id.");

  if (!active && isSelf(session.email, email)) {
    back(undefined, "That is your own account — ask another administrator to switch it off.");
  }

  const result = await updateSyncUser(id, { active });
  revalidatePath("/admin/people");
  if (!result.ok) back(undefined, result.reason ?? "The change was refused.");
  back(`${username || "That account"} is now ${active ? "active" : "switched off"}.`);
}
