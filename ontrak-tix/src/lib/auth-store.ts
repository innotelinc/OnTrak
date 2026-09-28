/**
 * Auth store (M0): looking a user up for a local sign-in.
 *
 * Like the ticket store, this is written against a small structural client
 * interface so it works with the generated tix Prisma client, a fake, or a
 * repository layer, and the tix schema stays independent of the training app's.
 */

import { isRole, type Role } from "./access-rules";
import type { TixSessionClaims } from "./session-rules";

export interface AuthUserRow {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: Role;
  active: boolean;
  passwordHash: string | null;
}

export interface AuthPrismaClient {
  user: {
    findMany(args: unknown): Promise<AuthUserRow[]>;
  };
}

/** Normalize an email for lookup; addresses are stored lower-case. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Find an active user by email.
 *
 * Email is only unique *within* a tenant, so a shared address across tenants is
 * ambiguous. The local fallback therefore refuses anything but a single match
 * rather than guessing a tenant — the IdP (with a tenant hint or SSO domain)
 * replaces this at M2.
 */
export async function findActiveUserByEmail(db: AuthPrismaClient, email: string): Promise<AuthUserRow | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  // Re-check active/role in code as well as in the query, so a caller that
  // ignores the filter (a fake, a careless repository) cannot widen access.
  const matches = (await db.user.findMany({ where: { email: normalized, active: true } })).filter(
    (user) => user.active && isRole(user.role),
  );
  return matches.length === 1 ? matches[0] : null;
}

/** The session a verified user should be issued. */
export function claimsForUser(user: AuthUserRow): TixSessionClaims {
  return { userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email, name: user.displayName };
}
