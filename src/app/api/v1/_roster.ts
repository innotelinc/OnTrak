/**
 * Who is enrolled, read the same way by the roster feed and its CSV export.
 *
 * The interesting part is `localPassword`. A roster is an identity document, not
 * a credential store: whether an account can be signed into locally is a fact an
 * administrator has to know *before* they hand out logins, so it is stated per
 * user as a boolean and the hash itself is never selected out of the database —
 * a `select` that cannot fetch a secret is the only kind that cannot leak one.
 */

import type { Role } from "@prisma/client";

import { prisma } from "@/lib/db";
import { MAX_LIMIT, DEFAULT_LIMIT } from "./_results";
import { ROSTER_ROLES } from "@/lib/csv-rules";

export const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  active: true,
  createdAt: true,
  memberships: { select: { cohort: { select: { id: true, name: true } }, isMentor: true } },
} as const;

type RosterUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  memberships: { cohort: { id: string; name: string }; isMentor: boolean }[];
};

export interface RosterFilters {
  role: Role | null;
  cohortId: string | null;
  limit: number;
  cursor: string | null;
}

export type RosterFilterRead = { ok: true; filters: RosterFilters } | { ok: false; reason: string };

export function readRosterFilters(params: URLSearchParams): RosterFilterRead {
  const role = (params.get("role") ?? "").trim().toUpperCase();
  if (role && !ROSTER_ROLES.includes(role as Role)) {
    return { ok: false, reason: `role must be one of ${ROSTER_ROLES.join(", ")}` };
  }
  const rawLimit = Number((params.get("limit") ?? "").trim());
  return {
    ok: true,
    filters: {
      role: role ? (role as Role) : null,
      cohortId: (params.get("cohortId") ?? "").trim() || null,
      limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(MAX_LIMIT, Math.floor(rawLimit)) : DEFAULT_LIMIT,
      cursor: (params.get("cursor") ?? "").trim() || null,
    },
  };
}

export async function loadRosterPage(filters: RosterFilters) {
  const rows = await prisma.user.findMany({
    where: {
      ...(filters.role ? { role: filters.role } : {}),
      ...(filters.cohortId ? { memberships: { some: { cohortId: filters.cohortId } } } : {}),
    },
    orderBy: [{ email: "asc" }, { id: "asc" }],
    take: filters.limit,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    select: USER_SELECT,
  });

  // Read in one query rather than a flag per row: the caller needs to know which
  // of *these* people can sign in, and an administrator provisioning a class
  // asks the question once.
  const withPassword = await prisma.user.findMany({
    where: { id: { in: rows.map((row) => row.id) }, passwordHash: { not: null } },
    select: { id: true },
  });
  const localPassword = new Set(withPassword.map((user) => user.id));

  const nextCursor = rows.length === filters.limit ? rows[rows.length - 1].id : null;
  return { rows, localPassword, nextCursor };
}

export type RosterRow = RosterUser;

export function toRosterJson(user: RosterUser, localPassword: boolean) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    active: user.active,
    /** Whether this account holds a local password, or signs in only at the provider. */
    localPassword,
    cohorts: user.memberships.map((membership) => ({
      id: membership.cohort.id,
      name: membership.cohort.name,
      isMentor: membership.isMentor,
    })),
  };
}

/** The roster as CSV rows: one line per user, their classes separated by `;`. */
export function toRosterCsvRow(user: RosterUser, localPassword: boolean) {
  return {
    email: user.email,
    name: user.name,
    role: user.role,
    cohorts: user.memberships.map((membership) => membership.cohort.name),
    active: user.active,
    localPassword,
  };
}
