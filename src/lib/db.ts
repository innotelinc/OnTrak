import { PrismaClient } from "@prisma/client";

/**
 * Prisma is instantiated once per process.  In development Next.js hot-reloads
 * modules constantly, so we stash the client on `globalThis` to avoid opening a
 * new connection pool on every edit.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** BigInt columns cannot be serialized by `JSON.stringify` directly. */
export function bigintToNumber(value: bigint | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}
