import { inCidr } from "./detection-rules";

/**
 * The mute (S4): which detections are **known** and should not be raised — a maintenance
 * window, a scanner this desk has already accepted, a load test it scheduled itself.
 *
 * Detection's job is to raise what is new; the mute is the operator's statement that some
 * of what it recognises is expected. Without it a known-noisy source produces a row every
 * scan forever, and a queue that is *mostly* known noise is a queue nobody reads — which is
 * how a real detection gets missed. Delivery (`alert-notify.ts`) stops an alert going
 * unheard; this is the other half, stopping one being raised at all.
 *
 * Four decisions are the design, and each is here rather than in the caller:
 *
 *   * **A mute ends.** `endsAt` is required and the window is capped
 *     (`SUPPRESSION_MAX_HOURS`), because a suppression with no end is a detection gap that
 *     nobody remembers creating. A mute that outlives its reason is indistinguishable from
 *     a rule that was switched off, and the difference matters at the review.
 *   * **A mute names *something*.** An empty matcher would mute everything, so a rule with
 *     no dimension set is refused rather than accepted as "any" — the one rule a person
 *     would create by accident is the one that turns the detector off entirely.
 *   * **Within a dimension it is a list, across dimensions it is an AND.** `sourceAddresses`
 *     of two CIDRs mutes either; a rule naming both a source and a rule id mutes only the
 *     intersection. That is what lets "our scanner, during the window" be said without also
 *     muting that address's real badness outside it.
 *   * **A mute is checked, not applied.** Nothing here raises or drops an alert: it answers
 *     *would this be muted, and by which rule*. The pipeline records what was suppressed, so
 *     the mute is evidence rather than an absence.
 *
 * What this module is **not**: storage, the clock, or the pipeline. It is the pure rule, in
 * the same shape `detection-rules.ts` and `enforcement-rules.ts` already take.
 */

/**
 * How long a mute may last, in hours.
 *
 * A week, deliberately not "forever": a maintenance window, a load test and a scanner's
 * visit are all bounded by nature, and the operator who needs longer than a week is really
 * asking for a rule change or a coverage decision — which should be a change to the rulebook
 * and not a silent, permanent silence of it.
 */
export const SUPPRESSION_MAX_HOURS = 24 * 7;

/** What a rule mutes. Every non-empty dimension must match; within one, any entry matches. */
export interface SuppressionMatcher {
  /** Rule ids (e.g. `SG-BEH-002`). Empty means "any rule". */
  ruleIds: string[];
  /** CIDRs or exact addresses. Empty means "any address". */
  sourceAddresses: string[];
  assets: string[];
  devices: string[];
  /** Identity ids. */
  identityIds: string[];
}

export interface SuppressionRule {
  id: string;
  organizationId: string;
  /** What the operator called it — "patch window", "our Nessus box". */
  name: string;
  matcher: SuppressionMatcher;
  startsAt: string;
  endsAt: string;
  createdById: string;
  createdByLabel: string;
  createdAt: string;
}

/** What is being judged: one draft the detector produced, flattened to what a rule can name. */
export interface SuppressionCandidate {
  ruleId: string;
  sourceAddress: string | null;
  asset: string | null;
  device: string | null;
  identityId: string | null;
}

/** The matcher an operator starts from: nothing selected, and therefore refused until they pick. */
export function emptyMatcher(): SuppressionMatcher {
  return { ruleIds: [], sourceAddresses: [], assets: [], devices: [], identityIds: [] };
}

/** The dimensions a matcher actually names, so "is this a mute of everything?" is answerable. */
export function matcherDimensions(matcher: SuppressionMatcher): number {
  return (
    matcher.ruleIds.length +
    matcher.sourceAddresses.length +
    matcher.assets.length +
    matcher.devices.length +
    matcher.identityIds.length
  );
}

/** Trim, drop blanks and de-duplicate, so a pasted list cannot carry a hole into the rule. */
function clean(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed !== "" && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export function normalizeMatcher(matcher: SuppressionMatcher): SuppressionMatcher {
  return {
    ruleIds: clean(matcher.ruleIds),
    sourceAddresses: clean(matcher.sourceAddresses),
    assets: clean(matcher.assets),
    devices: clean(matcher.devices),
    identityIds: clean(matcher.identityIds),
  };
}

export interface SuppressionDraft {
  name: string;
  matcher: SuppressionMatcher;
  startsAt: string;
  endsAt: string;
}

/**
 * Whether a draft is usable, or the sentence saying why not.
 *
 * Validated rather than trusted because every mute reads it, and the two that matter are the
 * ones a person gets wrong: an empty matcher and an end that is missing, in the past or too
 * far away.
 */
export function suppressionIssue(draft: SuppressionDraft): string | null {
  if (draft.name.trim() === "") {
    return "A mute needs a name — what is being silenced, and why, is what a reviewer reads.";
  }

  const matcher = normalizeMatcher(draft.matcher);
  if (matcherDimensions(matcher) === 0) {
    return "A mute has to name something — a rule, an address, an asset, a device or a person. A mute that names nothing would silence every detection.";
  }

  const starts = Date.parse(draft.startsAt);
  const ends = Date.parse(draft.endsAt);
  if (!Number.isFinite(starts)) return "The window has to start at a date and time.";
  if (!Number.isFinite(ends)) return "The window has to end at a date and time.";
  if (ends <= starts) {
    return "The window has to end after it starts; a mute that never begins is not a mute.";
  }

  const hours = (ends - starts) / (60 * 60 * 1000);
  if (hours > SUPPRESSION_MAX_HOURS) {
    return `A mute may last at most ${SUPPRESSION_MAX_HOURS} hours (a week). Longer than that is a coverage decision, not a window — change the rule instead.`;
  }
  return null;
}

/** Whether a rule's window covers `at`. A rule outside its window is inert, not deleted. */
export function suppressionActive(rule: SuppressionRule, at: string): boolean {
  const moment = Date.parse(at);
  const starts = Date.parse(rule.startsAt);
  const ends = Date.parse(rule.endsAt);
  if (!Number.isFinite(moment) || !Number.isFinite(starts) || !Number.isFinite(ends)) return false;
  return moment >= starts && moment < ends;
}

/** The rules whose window covers `at`, in the order they were given. */
export function activeSuppressions(
  rules: readonly SuppressionRule[],
  at: string,
): SuppressionRule[] {
  return rules.filter((rule) => suppressionActive(rule, at));
}

function matchesDimension(entries: readonly string[], value: string | null, addressRule: boolean): boolean {
  if (entries.length === 0) return true;
  if (value === null || value === "") return false;
  if (addressRule) {
    return entries.some((entry) => entry === value || inCidr(value, entry));
  }
  return entries.includes(value);
}

/** Whether every dimension this rule names matches the candidate. */
export function suppressionMatches(rule: SuppressionRule, candidate: SuppressionCandidate): boolean {
  const m = normalizeMatcher(rule.matcher);
  return (
    matchesDimension(m.ruleIds, candidate.ruleId, false) &&
    matchesDimension(m.sourceAddresses, candidate.sourceAddress, true) &&
    matchesDimension(m.assets, candidate.asset, false) &&
    matchesDimension(m.devices, candidate.device, false) &&
    matchesDimension(m.identityIds, candidate.identityId, false)
  );
}

/** The names in a matcher, for a sentence a person reads — the register and the audit row. */
export function describeMatcher(matcher: SuppressionMatcher): string {
  const m = normalizeMatcher(matcher);
  const parts: string[] = [];
  if (m.ruleIds.length > 0) parts.push(`rule ${m.ruleIds.join(", ")}`);
  if (m.sourceAddresses.length > 0) parts.push(`address ${m.sourceAddresses.join(", ")}`);
  if (m.assets.length > 0) parts.push(`asset ${m.assets.join(", ")}`);
  if (m.devices.length > 0) parts.push(`device ${m.devices.join(", ")}`);
  if (m.identityIds.length > 0) parts.push(`identity ${m.identityIds.join(", ")}`);
  return parts.join(" and ");
}

export interface SuppressionMatch {
  rule: SuppressionRule;
  /** A sentence for the audit row: which mute caught it, and until when. */
  reason: string;
}

/**
 * The active rule that mutes a candidate, or `null` when none does.
 *
 * The first match in the order given, so overlapping windows are decided by the list rather
 * than by whichever rule a map happened to yield first. `at` is passed in rather than read
 * from a clock for the same reason every other rule here is pure: the same inputs answer the
 * same way in a test and in a container.
 */
export function matchSuppression(
  candidate: SuppressionCandidate,
  rules: readonly SuppressionRule[],
  at: string,
): SuppressionMatch | null {
  for (const rule of activeSuppressions(rules, at)) {
    if (!suppressionMatches(rule, candidate)) continue;
    return {
      rule,
      reason: `Suppressed by “${rule.name}” (${describeMatcher(rule.matcher)}) until ${rule.endsAt}.`,
    };
  }
  return null;
}
