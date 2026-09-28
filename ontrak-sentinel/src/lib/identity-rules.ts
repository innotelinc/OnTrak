/**
 * Identity rules (S0): the small, pure decisions the login path and the
 * enforcement gate share with tests. Framework-free on purpose.
 */

export type IdentityRole = "ADMIN" | "AGENT" | "SERVICE" | "AUDITOR";

export interface IdentityPolicy {
  /** Require a second factor before any interactive session is granted. */
  requireMfa: boolean;
  /** Absolute session lifetime in seconds. */
  maxSessionSeconds: number;
  /** Idle timeout in seconds. */
  idleTimeoutSeconds: number;
}

export const DEFAULT_IDENTITY_POLICY: IdentityPolicy = {
  requireMfa: true,
  maxSessionSeconds: 60 * 60 * 12,
  idleTimeoutSeconds: 60 * 30,
};

export interface IdentitySummary {
  id: string;
  role: IdentityRole;
  active: boolean;
  mfaEnrolled: boolean;
}

export interface SessionInfo {
  /** Epoch milliseconds, server-authoritative. */
  issuedAt: number;
  lastSeenAt: number;
  revokedAt?: number | null;
}

export type SessionDecision = { active: true } | { active: false; reason: string };

/**
 * Decide whether a session is still usable. Order matters: a revoked or
 * deactivated identity is rejected before any timeout is considered.
 */
export function sessionDecision(
  identity: IdentitySummary,
  session: SessionInfo,
  policy: IdentityPolicy = DEFAULT_IDENTITY_POLICY,
  now: number = Date.now(),
): SessionDecision {
  if (!identity.active) return { active: false, reason: "identity is deactivated" };
  if (session.revokedAt != null) return { active: false, reason: "session was revoked" };
  if (policy.requireMfa && !identity.mfaEnrolled) {
    return { active: false, reason: "MFA is required but not enrolled" };
  }
  if (now - session.issuedAt >= policy.maxSessionSeconds * 1000) {
    return { active: false, reason: "session exceeded its maximum lifetime" };
  }
  if (now - session.lastSeenAt >= policy.idleTimeoutSeconds * 1000) {
    return { active: false, reason: "session idle timeout" };
  }
  return { active: true };
}

/**
 * Who may authorise a Guard prevention action. Prevention can break production,
 * so in v1 only an administrator can approve it — the safety rail that keeps
 * enforcement approval-gated and auditable.
 */
export function canApproveEnforcement(role: IdentityRole): boolean {
  return role === "ADMIN";
}
