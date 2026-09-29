"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { createSession, destroySession, hashPassword, pickAccent, ROLE_HOME, verifyPassword } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import {
  allowSelfRegistration,
  CREDENTIALS,
  joinOutcome,
  normalizeJoinCode,
  REGISTRATION,
  safeRelativePath,
} from "@/lib/auth-rules";

export interface AuthState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = CREDENTIALS.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return {
      fieldErrors: Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message])),
    };
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  // Same message for "no such user", "wrong password" and "this account signs in
  // through the identity provider" — the visitor gets told nothing about which of
  // the three it was, so the form cannot be used to enumerate accounts.
  if (!user || !user.passwordHash || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return { error: "That email and password combination did not match our records." };
  }
  if (!user.active) {
    return { error: "This account has been deactivated. Ask an administrator to re-enable it." };
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await createSession({ id: user.id, email: user.email, name: user.name, role: user.role, accent: user.accent });
  await recordAudit({ actorId: user.id, action: "auth.sign_in", targetType: "user", targetId: user.id });

  redirect(safeRelativePath(formData.get("next")) ?? ROLE_HOME[user.role]);
}

export async function signUp(_prev: AuthState, formData: FormData): Promise<AuthState> {
  if (!allowSelfRegistration()) {
    return { error: "Self-registration is disabled on this deployment. Ask an instructor for an account." };
  }

  const parsed = REGISTRATION.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    joinCode: formData.get("joinCode") || undefined,
  });

  if (!parsed.success) {
    return {
      fieldErrors: Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message])),
    };
  }

  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (existing) {
    return { fieldErrors: { email: "An account with that email already exists." } };
  }

  // Resolve the class code before creating the account: a student who mistyped
  // the code should be told so they can fix it, not silently dropped into a
  // class-less account they cannot correct afterwards.
  const joinCode = normalizeJoinCode(parsed.data.joinCode);
  const cohort = joinCode ? await prisma.cohort.findUnique({ where: { joinCode } }) : null;
  const join = joinOutcome(parsed.data.joinCode, cohort !== null);
  if (join.kind === "unknown") {
    return { fieldErrors: { joinCode: join.message } };
  }

  const user = await prisma.user.create({
    data: {
      name: parsed.data.name,
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
      role: "STUDENT",
      accent: pickAccent(parsed.data.email),
    },
  });

  // Joining a class by code puts the new student straight into the roster.
  if (join.kind === "join" && cohort) {
    await prisma.cohortMember.create({ data: { cohortId: cohort.id, userId: user.id } }).catch(() => undefined);
  }

  await createSession({ id: user.id, email: user.email, name: user.name, role: user.role, accent: user.accent });
  await recordAudit({ actorId: user.id, action: "auth.register", targetType: "user", targetId: user.id });

  redirect("/student");
}

export async function signOut(): Promise<void> {
  await destroySession();
  redirect("/login");
}
