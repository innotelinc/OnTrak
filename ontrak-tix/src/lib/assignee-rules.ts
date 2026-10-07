/**
 * Assignee options (M0 inbox): the staff a ticket can actually be handed to.
 *
 * Pure, so the picker's contents are testable without a database. A caller reads the
 * tenant's active staff and passes them here; a person with no display name is
 * labelled by their email rather than by an opaque id, because "who is this?" is the
 * whole question an assignment answers — and a free-text box asking an agent to type
 * a raw user id is a picker that answers nothing.
 *
 * Requesters are deliberately absent: a ticket is assigned to staff, and offering the
 * person who raised it would make "assigned" mean two different things.
 */

import type { Role } from "./access-rules";

/** A candidate assignee, as a picker shows it. */
export interface AssigneeOption {
  id: string;
  /** The label shown: the display name, or the email when there is none. */
  name: string;
}

/** The staff roles a ticket may be assigned to. Requesters are never assignees. */
export const ASSIGNEE_ROLES: readonly Role[] = ["ADMIN", "DISPATCHER", "AGENT"];

/** The staff-shaped fields the option builder needs. */
export interface StaffLike {
  id: string;
  displayName?: string | null;
  email?: string | null;
}

/**
 * The options a picker shows, sorted by label so the desk reads alphabetically
 * rather than in whatever order the database returned rows.
 */
export function assigneeOptions(staff: readonly StaffLike[]): AssigneeOption[] {
  return staff
    .map((person) => ({
      id: person.id,
      name: (person.displayName ?? "").trim() || (person.email ?? "").trim() || person.id,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
