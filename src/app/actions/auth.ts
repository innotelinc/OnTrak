"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { createSession, destroySession, hashPassword, pickAccent, ROLE_HOME, verifyPassword } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { classAdmission } from "@/lib/program-admission";
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
  await createSession({ id: user.id, email: user.email, name: user.name, role: user.role });
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

  // A funded class carries the funder's admission rules into the sign-up form as well. This is
  // the second door into a class, and the one nobody has to be given access to walk through: a
  // slot delivered to an employer without a current memo, or past its cap, is as unreimbursable
  // whether an administrator enrolled the learner or the learner enrolled themselves. It is
  // asked before the account exists so the answer is a field error the person can act on — ask
  // the provider, or join a different class — rather than an account they cannot explain.
  if (join.kind === "join" && cohort) {
    const admission = await classAdmission(cohort);
    if (admission.length > 0) return { fieldErrors: { joinCode: admission[0].message } };
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

  // Joining a class by code puts the new student straight into the roster — and, when the class
  // belongs to a provider tenancy, into the enrolment the funder's report reads. The roster and
  // the funder's figures describing the same class differently is the bug this prevents.
  if (join.kind === "join" && cohort) {
    await prisma.cohortMember.create({ data: { cohortId: cohort.id, userId: user.id } }).catch(() => undefined);
    if (cohort.organizationId) {
      await prisma.enrollment
        .create({
          data: {
            cohortId: cohort.id,
            userId: user.id,
            organizationId: cohort.organizationId,
            sponsorOrganizationId: cohort.sponsorOrganizationId,
          },
        })
        .catch(() => undefined);
    }
  }

  await createSession({ id: user.id, email: user.email, name: user.name, role: user.role });
  await recordAudit({ actorId: user.id, action: "auth.register", targetType: "user", targetId: user.id });

  redirect("/student");
}

export async function signOut(): Promise<void> {
  await destroySession();
  redirect("/login");
}
