/**
 * Reset the demo lab's attempt state.
 *
 *   npm run db:reset-demo
 *
 * Clears every attempt belonging to the seeded demo students so they can start
 * scenarios fresh — an assignment's attempt cap counts finished attempts, so
 * this is what un-blocks a student who has "used all 3 attempts". It also
 * deletes the synthetic `a11y-*` accounts the browser accessibility sweep leaves
 * behind. Accounts, classes and scenarios are otherwise left alone, and the
 * append-only audit log is never touched: this is lab data, not an evidence
 * store.
 *
 * The selection rules live in `src/lib/demo-reset-rules.ts` and are unit tested.
 */

import { PrismaClient } from "@prisma/client";
import { shouldClearAttempts, shouldDeleteUser } from "../src/lib/demo-reset-rules";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const users = await prisma.user.findMany({ select: { id: true, email: true } });

  const deleteIds = users.filter((user) => shouldDeleteUser(user.email)).map((user) => user.id);
  // Demo students are kept; only their attempts go. Excluding the accounts about
  // to be deleted keeps the reported counts honest (their attempts cascade).
  const clearIds = users
    .filter((user) => shouldClearAttempts(user.email) && !deleteIds.includes(user.id))
    .map((user) => user.id);

  const removedUsers = deleteIds.length
    ? (await prisma.user.deleteMany({ where: { id: { in: deleteIds } } })).count
    : 0;

  const clearedAttempts = clearIds.length
    ? (await prisma.attempt.deleteMany({ where: { userId: { in: clearIds } } })).count
    : 0;

  console.log(`Removed ${removedUsers} synthetic test account(s).`);
  console.log(`Cleared ${clearedAttempts} attempt(s) for ${clearIds.length} demo student(s).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
