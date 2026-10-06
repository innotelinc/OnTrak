/**
 * LTI service: what a launch *does* to this deployment.
 *
 * `lti-rules.ts` decides what a launch means; this module decides what it changes,
 * and it borrows the account half wholesale from `oidc-service.ts` — a launch and
 * a sign-in both end in "find this person here, or make them an account", and
 * answering that twice would be how the two paths start disagreeing about who
 * somebody is.
 *
 * One deliberate difference. The platform's `sub` is namespaced with the issuer
 * before it becomes `externalId`, because two installations of the same product on
 * two platforms both start their subject ids at `1`. Namespacing is what keeps the
 * unique index meaningful; without it, the second platform's first learner would
 * collide with the first platform's.
 *
 * The known consequence, stated rather than hidden: a person who arrives through
 * *both* the directory and an LMS is matched by email on the second path, and the
 * `externalId` then follows whichever provider signed in last. They are one
 * account either way — the email match is what guarantees that — but the stored
 * subject is not a joint fact, and a deployment that wants one should offer one
 * way in. `docs/integrations.md` says so.
 */

import type { SsoAuthorization } from "./oidc-rules";
import type { SsoSignInResult } from "./oidc-service";
import type { LtiLaunch } from "./lti-rules";

/**
 * The provider subject this launch stands for.
 *
 * `lti:<issuer>#<sub>`, which is stable across launches, unique across platforms,
 * and recognisable in the database when somebody is looking at why one account
 * exists twice.
 */
export function ltiExternalId(launch: LtiLaunch): string {
  return `lti:${launch.issuer}#${launch.subject}`;
}

/** A launch, as the account path already understands a sign-in. */
export function launchAuthorization(launch: LtiLaunch): SsoAuthorization {
  return {
    email: launch.email,
    subject: ltiExternalId(launch),
    name: launch.name,
    role: launch.localRole,
    mapped: launch.roleMapped,
  };
}

/**
 * The audit entries the launch path appends.
 *
 * A successful launch records which platform, which course and which resource
 * link — the three facts an investigation into "why did this person see that"
 * needs, and none of which is visible from this side afterwards. A refusal is
 * recorded too, for the same reason a denied sign-in is: an LMS integration that
 * fails is a support ticket, and the ticket is only answerable if the failure was
 * written down.
 */
export function ltiLaunchAudit(
  launch: LtiLaunch,
  result: SsoSignInResult,
): {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
} {
  return {
    actorId: result.user.id,
    action: "auth.lti_launch",
    targetType: "user",
    targetId: result.user.id,
    detail: {
      platform: launch.issuer,
      deployment: launch.deploymentId,
      resourceLink: launch.resourceLink.id,
      context: launch.context.id,
      role: result.user.role,
      mapped: launch.roleMapped,
      provisioned: result.provisioned,
      ...(launch.lineItem ? { gradePassback: true } : {}),
      ...(result.roleChanged ? { roleChanged: true } : {}),
      ...(result.note ? { note: result.note } : {}),
    },
  };
}

export function ltiDeniedAudit(
  platform: string,
  reason: string,
): {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
} {
  return {
    actorId: null,
    action: "auth.lti_launch_denied",
    targetType: "user",
    targetId: "",
    // No email: a refused launch must not write somebody's address into the trail,
    // exactly as a refused sign-in does not.
    detail: { platform, reason },
  };
}
