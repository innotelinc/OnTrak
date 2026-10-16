import type { SessionUser } from "./auth";

/**
 * Who may see and do what across tenancies.
 *
 * One deployment carries more than one organisation, so every read that can return
 * another organisation's rows has to say which organisation it means. These helpers are
 * the one place that answers, so the answer cannot differ between two pages that both
 * look correct on their own.
 *
 * The rule has three parts, and the third is the one that is easy to forget:
 *
 *   1. an ordinary person sees their own tenancy's rows and nothing else;
 *   2. the platform operator sees every tenancy, because creating and inspecting them is
 *      the job — `platformAdmin` is a flag on the account, not a fourth role;
 *   3. a row with no organisation at all is the *shared* catalogue (the built-in
 *      scenarios), which every tenancy may use but none may edit.
 *
 * A signed-out caller is refused rather than defaulted: `null` is not "everything".
 */

/** The tenant a person belongs to, or null when they belong to none yet. */
export function tenantIdOf(user: Pick<SessionUser, "organizationId">): string | null {
  return user.organizationId ?? null;
}

export function isPlatformOperator(user: Pick<SessionUser, "platformAdmin">): boolean {
  return user.platformAdmin;
}

/**
 * The filter a tenant-scoped query passes to Prisma.
 *
 * `{}` for the operator is deliberate and is the only way to see all tenancies; every
 * other caller gets an equality on their own id, and a caller with no tenancy gets a
 * filter that matches nothing (`__none__`) rather than no filter at all — an account that
 * has not been placed in a tenancy yet must not accidentally read every one of them.
 */
export function tenantFilter(user: Pick<SessionUser, "organizationId" | "platformAdmin">): {
  organizationId?: string;
} {
  if (isPlatformOperator(user)) return {};
  return { organizationId: tenantIdOf(user) ?? "__none__" };
}

/**
 * The catalogue rule, spelled out: the shared built-ins plus this tenancy's own work.
 * The operator sees the union of everything, which is what makes the operator's own
 * catalogue view useful rather than empty.
 */
export function catalogFilter(user: Pick<SessionUser, "organizationId" | "platformAdmin">): {
  OR?: Array<Record<string, unknown>>;
  organizationId?: string | null;
} {
  if (isPlatformOperator(user)) return {};
  const mine = tenantIdOf(user);
  return mine === null ? { organizationId: null } : { OR: [{ organizationId: null }, { organizationId: mine }] };
}

/** Whether this person may change rows owned by this tenancy. */
export function canManageTenant(
  user: Pick<SessionUser, "organizationId" | "platformAdmin" | "role">,
  organizationId: string | null,
): boolean {
  if (isPlatformOperator(user)) return true;
  if (organizationId === null) return false;
  if (tenantIdOf(user) !== organizationId) return false;
  return user.role === "ADMIN" || user.role === "INSTRUCTOR";
}

/** Only the operator creates tenancies — that is the whole point of the flag. */
export function canCreateTenants(user: Pick<SessionUser, "platformAdmin">): boolean {
  return isPlatformOperator(user);
}

/**
 * Whether this person may be given the run of one tenancy: its programs, its catalogue,
 * its people. An operator may act in any tenancy; inside their own, an ADMIN may.
 */
export function canAdministerTenant(
  user: Pick<SessionUser, "organizationId" | "platformAdmin" | "role">,
  organizationId: string,
): boolean {
  if (isPlatformOperator(user)) return true;
  return tenantIdOf(user) === organizationId && user.role === "ADMIN";
}
