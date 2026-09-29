"use server";

/**
 * Break-glass sign-in.
 *
 * This is the one place in Tix that reads a password hash, and it is reached only
 * from `/sign-in/break-glass` — the unlinked fallback for the day the identity
 * provider is down. The normal path is single sign-on (`/api/sso/start`), which
 * never sees a password at all.
 *
 * Credentials are verified here, then a tenant-scoped session is issued. Every
 * other action trusts the signed session and re-checks the tenant on the row it
 * touches.
 */

import { redirect } from "next/navigation";

import { prisma } from "../../lib/db";
import { verifyPassword } from "../../lib/password";
import { claimsForUser, findActiveUserByEmail, type AuthPrismaClient } from "../../lib/auth-store";
import { createTixSession } from "../../lib/session";

export async function signInAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const user = await findActiveUserByEmail(prisma as unknown as AuthPrismaClient, email);
  const ok = user !== null && verifyPassword(password, user.passwordHash);

  if (!ok || !user) {
    redirect(`/sign-in/break-glass?error=${encodeURIComponent("Wrong email or password.")}`);
  }

  await createTixSession(claimsForUser(user));
  redirect(user.role === "REQUESTER" ? "/portal" : "/dashboard");
}
