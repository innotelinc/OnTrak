/**
 * Gathers the reference sets the attempt-visibility rule needs.
 *
 * Kept apart from `attempt-rules.ts` so the rule itself stays pure and can be
 * unit-tested: this module is the only part that touches the database.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { attemptScopeWhere, type AttemptScopeRefs } from "./attempt-rules";

/**
 * The `attempt` filter for this viewer. Administrators get an empty filter;
 * instructors get the union of their students, their authored scenarios and
 * their assignments; everyone else gets their own attempts.
 */
export async function attemptScopeFor(viewer: {
  id: string;
  role: string;
}): Promise<Prisma.AttemptWhereInput> {
  if (viewer.role === "ADMIN") return {};
  if (viewer.role !== "INSTRUCTOR") return { userId: viewer.id };

  const cohorts = await prisma.cohort.findMany({
    where: { instructorId: viewer.id },
    select: { id: true },
  });
  const [members, scenarios] = await Promise.all([
    prisma.cohortMember.findMany({
      where: { cohortId: { in: cohorts.map((cohort) => cohort.id) } },
      select: { userId: true },
    }),
    prisma.scenario.findMany({ where: { authorId: viewer.id }, select: { id: true } }),
  ]);

  const refs: AttemptScopeRefs = {
    studentIds: [...new Set(members.map((member) => member.userId))],
    scenarioIds: scenarios.map((scenario) => scenario.id),
  };
  return attemptScopeWhere(viewer, refs);
}
