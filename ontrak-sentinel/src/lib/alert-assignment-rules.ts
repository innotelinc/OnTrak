/**
 * Who an alert may be handed to (S3), and nothing else.
 *
 * The queue shipped with everything an operator needs to read an incident and nothing that
 * says who is holding it, so the working practice was "one alert at a time, by whoever gets
 * there first" — which is how two people acknowledge the same incident and neither
 * investigates it. Ownership is the missing field; this module is the missing judgement.
 *
 * **Why this is a file of its own rather than two functions beside the queue.** The rule is
 * needed in three places: the queue's rules (`alert-triage-rules.ts`), the service that
 * performs the handover (`detection-service.ts`), and the page that offers the picker
 * (`console-*.ts`). The first of those already imports the second — the alert record and its
 * states are its subject — so a rule living there and used by the service would close a
 * require cycle, and the symptom is not a tidy error: it is `Cannot access 'ALERT_STATES'
 * before initialization`, thrown at import, before any test runs. This module therefore
 * depends on the identity rules and on nothing that depends on it, which is what makes all
 * three readers able to share one statement of the rule.
 *
 * **One rule, three readers, and the reason that matters.** `assignableIdentities` filters
 * through `assignmentRefusal` rather than restating it, so the picker the console renders and
 * the check the service makes cannot disagree. A page offering a name the service then refuses
 * would make the refusal read as a bug in triage rather than as a rule about people, and the
 * operator would go looking for the wrong problem.
 */

import type { IdentityRecord } from "./identity-rules";

/** One identity an alert may be handed to, as a picker needs it. */
export interface AssignableIdentity {
  id: string;
  label: string;
}

/**
 * Why this identity cannot be given an alert, or `null` when it can.
 *
 * Note what an unknown identity means here. `findIdentity` is scoped to the caller's
 * organization, so an identity in another organization comes back as *absent* rather than
 * forbidden — the same answer the spine gives everywhere else, and the only one a caller can
 * act on without learning that the other tenant exists.
 *
 * The other two refusals are the interesting ones, and both are about the queue rather than
 * about permissions:
 *
 *  - **A deactivated identity cannot own an alert.** An alert assigned to somebody who has
 *    been switched off is worse than an unassigned one, because it *looks* owned: the page
 *    says a name, the queue filter for "unassigned" does not show it, and nobody ever picks it
 *    up. Offboarding already ends that person's sessions and revokes their tokens; this is the
 *    same fact one level out.
 *  - **A service identity cannot own one.** `SERVICE` is how a machine authenticates — a
 *    connector, a sensor's deployment, a script. An incident belongs to a person who can be
 *    asked about it, and handing one to a machine account is a way of making it look handled.
 */
export function assignmentRefusal(identity: Pick<IdentityRecord, "active" | "kind"> | null): string | null {
  if (!identity) return "That is not an identity in this organization.";
  if (!identity.active) {
    return "That identity is deactivated, so it cannot own an alert — an alert nobody will pick up is worse than one nobody has picked up yet.";
  }
  if (identity.kind !== "HUMAN") return "A service identity is not somebody who can own an alert.";
  return null;
}

/**
 * The people an alert can be given to.
 *
 * Active humans only, and sorted by name because a picker is read by a person. The display
 * name is preferred over the identifier because that is what an operator recognises in a
 * list, with the identifier as the fallback for an identity that was created without one.
 */
export function assignableIdentities(identities: readonly IdentityRecord[]): AssignableIdentity[] {
  return identities
    .filter((identity) => assignmentRefusal(identity) === null)
    .map((identity) => ({ id: identity.id, label: identity.displayName || identity.identifier }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}
