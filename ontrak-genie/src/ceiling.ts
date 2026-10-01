import { config } from "./config.js";

/**
 * The ceiling Genie enforces by itself.
 *
 * Distro's control plane already answers "may this account spend?", and it is
 * the *billing* authority: its `requestsPerDay` is a plan, and the family runs
 * on unlimited usage, so it never says no. What it cannot be is a bound on a
 * runaway agent loop, because with unlimited usage there is nothing in the plan
 * to bound. This is that bound, and it is deliberately Genie's own number rather
 * than a price: `AGENT_ACCOUNT_CEILING_REQUESTS` is how many turns one account
 * may start in a day on *this* deployment, whatever the plane thinks of it.
 *
 * Three decisions carry it.
 *
 *   * **A turn is counted where it is decided, not where it is billed.** The
 *     count is taken in `beginTurn`, after the plane has allowed the turn: the
 *     gate that spends is the gate that counts, so there is no path into the
 *     model that skips the ceiling.
 *   * **The day is UTC and the reset is a comparison, not a timer.** Nothing
 *     has to run at midnight; a count kept beside the day it belongs to is simply
 *     not found the next day, which is also why a process that restarts mid-day
 *     cannot double-count or leak.
 *   * **It is a runaway stop, not a licence.** A reminder-of-what-you-spent
 *     would be the ledger's job (and `GET /api/account/usage` already does it).
 *     This is the thing that ends a loop at 3am, so it is *in-process* on
 *     purpose: the ceiling resets with a restart, and that is the correct
 *     trade — a durable counter is a billing mechanism wearing a safety belt.
 *     The refusal says which one it is.
 *
 * `0` disables it, which is the shipped default: a single-operator deployment
 * has no account to key on, and even a tenanted one should have to opt in to a
 * number this blunt.
 */

/** A ceiling and where the account stands against it, for the console to read. */
export type Ceiling = {
  /** Turns per day this deployment allows. `0` means Genie enforces none. */
  limit: number;
  /** Turns started today, as Genie counted them. */
  used: number;
  /** Turns left today, or null when nothing is enforced. */
  remaining: number | null;
  /** Whether the next turn may start. */
  allowed: boolean;
};

/** What the caller is told when the ceiling is the reason the turn did not start. */
export function ceilingMessage(limit: number, used: number): string {
  return (
    `This account has started ${used} turns today, and this deployment's ceiling is ${limit} ` +
    `per day. Genie enforces that itself, so it is a stop on a runaway loop rather than a bill; ` +
    `it clears at midnight UTC.`
  );
}

/** The UTC day a count belongs to. Midnight is the boundary, and nothing runs at it. */
export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Counts held beside the day that gave them meaning.
 *
 * Keyed on the control-plane account id, which is what a turn is billed to, so
 * the ceiling and the ledger agree about who this was.
 */
const counts = new Map<string, { day: string; used: number }>();

function read(userId: string, now: number): { day: string; used: number } {
  const day = utcDay(now);
  const held = counts.get(userId);
  // A count from another day is not this account's count; it is dropped rather
  // than carried, which is what makes the reset happen without a timer.
  if (held === undefined || held.day !== day) {
    const fresh = { day, used: 0 };
    counts.set(userId, fresh);
    return fresh;
  }
  return held;
}

/**
 * Where this account stands against the ceiling. Never refuses; callers decide.
 *
 * The limit is a parameter so the rule can be tested at the values a deployment
 * actually has (`0` above all) without a second process; production never passes
 * it and reads `AGENT_ACCOUNT_CEILING_REQUESTS`.
 */
export function ceilingFor(
  userId: string,
  now = Date.now(),
  limit = config.accountCeilingRequests,
): Ceiling {
  const { used } = read(userId, now);
  if (limit <= 0) {
    return { limit: 0, used, remaining: null, allowed: true };
  }
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    allowed: used < limit,
  };
}

/** Record that a turn was allowed to start, so the next one is measured after it. */
export function noteTurn(userId: string, now = Date.now()): Ceiling {
  const held = read(userId, now);
  held.used += 1;
  return ceilingFor(userId, now);
}

/** Only for tests: an account's count would otherwise leak between cases. */
export function resetCeilings(): void {
  counts.clear();
}
