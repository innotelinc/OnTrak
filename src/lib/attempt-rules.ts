/**
 * Who may see whose attempt records, as a pure function.
 *
 * Scenarios are a shared staff catalog — any instructor may read and edit any
 * scenario. Attempts are different: they are a student's own work, and one
 * instructor should not be able to browse another instructor's cohort results.
 * The visible set is therefore the union of:
 *
 *   - students enrolled in a class this instructor teaches;
 *   - scenarios this instructor authored (they need to see how their own
 *     scenario performs, even when someone else assigned it);
 *   - attempts this instructor assigned.
 *
 * Administrators see everything; a student sees only their own attempts.
 * Translating this into the actual queries lives in `attempt-scope.ts`, so the
 * decision itself can be unit-tested without a database.
 */

import type { Prisma } from "@prisma/client";

export interface AttemptScopeRefs {
  /** Users enrolled in a class this instructor teaches. */
  studentIds: readonly string[];
  /** Scenarios this instructor authored. */
  scenarioIds: readonly string[];
}

/**
 * The `attempt` filter that limits a viewer to the work they are entitled to.
 * Returns an empty filter for an administrator, which Prisma reads as "no
 * restriction".
 */
export function attemptScopeWhere(
  viewer: { id: string; role: string },
  refs: AttemptScopeRefs,
): Prisma.AttemptWhereInput {
  if (viewer.role === "ADMIN") return {};
  if (viewer.role !== "INSTRUCTOR") return { userId: viewer.id };

  return {
    OR: [
      { userId: { in: [...refs.studentIds] } },
      { scenarioId: { in: [...refs.scenarioIds] } },
      { assignment: { createdById: viewer.id } },
    ],
  };
}
