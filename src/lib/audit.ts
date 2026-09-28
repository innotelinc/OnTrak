import "server-only";

import { prisma } from "./db";

export interface AuditInput {
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Append an entry to the audit trail.
 *
 * Auditing must never break the operation it is describing, so failures are
 * swallowed after being reported to the server log.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        detail: (input.detail ?? {}) as object,
      },
    });
  } catch (error) {
    console.error("[audit] failed to record", input.action, error);
  }
}

export async function recentAudit(limit = 50) {
  return prisma.auditLog.findMany({
    take: limit,
    orderBy: { createdAt: "desc" },
    include: { actor: { select: { name: true, email: true } } },
  });
}
