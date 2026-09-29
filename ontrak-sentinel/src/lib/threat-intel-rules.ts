/**
 * Threat intelligence rules (S3): indicators of compromise, and what a match means.
 *
 * Guard's rules answer "what happened". This module answers the other half of a SOC's
 * question — "have we seen this before, and does anybody else think it is bad?" — by
 * joining an observation to a feed of indicators: addresses, domains, URLs and file
 * hashes that somebody has already decided to be worth watching.
 *
 * Six decisions worth stating out loud, because each is a way this becomes noise:
 *
 *  - **An indicator is matched by kind, never by substring.** A domain indicator
 *    compared as a substring matches `not-evil-vendor.example` for `vendor.example`, and
 *    a feed with a hundred thousand rows would produce an alert on the word. Each kind
 *    has one comparison, and it is exact (plus the subdomain rule below).
 *  - **A `*.` prefix is a decision, not a wildcard convenience.** `*.bad.example` means
 *    the domain *and* anything under it. Anything else matches one host exactly — a feed
 *    that says `bad.example` is not claiming its subdomains are bad, and pretending it
 *    did is how a shared-hosting neighbour becomes an incident.
 *  - **An expired indicator never matches.** Curation is a gift with a date on it: an
 *    address is reassigned, a domain is re-registered, and a list nobody pruned reports
 *    the innocent for years. Expiry is enforced in the matcher rather than by a sweep, so
 *    there is no window in which the sweep has not run yet.
 *  - **A match annotates and escalates; it does not raise an alert by itself.** "This
 *    address is on a list" is not a claim that anything happened, and an alert that says
 *    only that is an alert nobody can action. What a match does is change how an
 *    *existing* detection is judged — and the alert keeps which indicator, from which
 *    feed, at what confidence, so the escalation is reviewable rather than mysterious.
 *  - **Confidence is carried, and there is a floor before it alarms.** A fifty-source
 *    feed and a hobby list are not equally worth waking somebody for. Below
 *    `CONFIDENCE_FLOOR` a match is recorded as context and the severity is left alone.
 *  - **Indicators are data, like rules.** A value that can be listed, versioned, counted
 *    and tested is what makes "the feed works" a claim about the code that runs.
 */

import { inCidr, type Severity } from "./detection-rules";
import type { ObservedEvent } from "./telemetry-rules";

/* -------------------------------------------------------------------------- */
/*  Indicators                                                                */
/* -------------------------------------------------------------------------- */

export const INDICATOR_KINDS = ["IPV4", "IPV6", "CIDR", "DOMAIN", "URL", "MD5", "SHA1", "SHA256"] as const;
export type IndicatorKind = (typeof INDICATOR_KINDS)[number];

/** How much a feed's word is worth, out of 100. A match below the floor only annotates. */
export const CONFIDENCE_FLOOR = 60;

export interface Indicator {
  /** Derived from the kind and the canonical value — see `indicatorId`. */
  id: string;
  kind: IndicatorKind;
  /** Canonical form, as `canonicalValue` produces it. */
  value: string;
  /** Whether `value` was given as `*.` — the domain and anything under it. */
  wildcard: boolean;
  /** Which feed this came from, named, so a bad feed can be found and turned off. */
  source: string;
  /** 0–100. */
  confidence: number;
  /** The feed's own severity for a hit, when it has an opinion. */
  severity: Severity | null;
  labels: readonly string[];
  /** Epoch ms. `null` means it does not expire, which a deployment should be able to see. */
  expiresAt: number | null;
  firstSeenAt: number;
}

/** Where an indicator was seen on an event, so the alert can say what matched. */
export type ObservableField = "sourceAddress" | "destinationAddress" | "attribute";

export interface IndicatorMatch {
  indicator: Indicator;
  field: ObservableField;
  /** The attribute name, when `field` is `attribute`. */
  attribute: string | null;
  /** The value on the event that matched, exactly as the sensor reported it. */
  observable: string;
  /** Whether this match is allowed to change the severity. */
  escalates: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Reading an indicator                                                      */
/* -------------------------------------------------------------------------- */

const HEX = /^[0-9a-f]+$/;
const HASH_LENGTHS: Record<number, IndicatorKind> = { 32: "MD5", 40: "SHA1", 64: "SHA256" };

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isIpv6(value: string): boolean {
  // Deliberately shallow: anything with a colon and at least one hex group that is not an
  // IPv4 address. A full parser here would not make a match any more correct, because the
  // comparison is string equality either way.
  return value.includes(":") && /^[0-9a-f:]+$/.test(value);
}

function isCidr(value: string): boolean {
  if (!value.includes("/")) return false;
  const [network, bits] = value.split("/");
  if (!isIpv4(network)) return false;
  const prefix = Number(bits);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
}

function isDomain(value: string): boolean {
  const host = value.startsWith("*.") ? value.slice(2) : value;
  if (host.length === 0 || host.length > 253) return false;
  if (isIpv4(host) || host.includes(":")) return false;
  // At least one dot and a TLD of two or more letters. `localhost` is not a domain a feed
  // can meaningfully list, and neither is a bare word.
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host) &&
    /\.[a-z]{2,}$/i.test(host);
}

function isUrl(value: string): boolean {
  return /^https?:\/\/[^\s/]+/i.test(value);
}

/**
 * What kind of indicator a value is, or `null` when it is none of them.
 *
 * Refusing is the point. A feed that ships a paragraph of prose, a `TODO`, or an empty
 * cell should produce a rejection an operator can see, not an indicator that will never
 * match anything and will sit in the list looking like protection.
 */
export function classifyIndicator(value: string): IndicatorKind | null {
  const text = (value ?? "").trim();
  if (text.length === 0) return null;
  if (isCidr(text)) return "CIDR";
  if (isIpv4(text)) return "IPV4";
  if (HEX.test(text) && HASH_LENGTHS[text.length]) return HASH_LENGTHS[text.length];
  if (isUrl(text)) return "URL";
  if (isIpv6(text)) return "IPV6";
  if (isDomain(text)) return "DOMAIN";
  return null;
}

/** The single spelling of a value, so the same indicator from two feeds is one row. */
export function canonicalValue(kind: IndicatorKind, value: string): string {
  const text = value.trim();
  switch (kind) {
    case "IPV4":
    case "IPV6":
    case "CIDR":
      return text.toLowerCase();
    case "DOMAIN": {
      const bare = text.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
      return text.startsWith("*.") ? `*.${bare}` : bare;
    }
    case "URL":
      // The scheme and host are case-insensitive; the path is not, and is left alone.
      return text.replace(/^([a-z]+:\/\/)([^/]*)/i, (_, scheme: string, host: string) => `${scheme.toLowerCase()}${host.toLowerCase()}`);
    default:
      return text.toLowerCase();
  }
}

export function isWildcard(kind: IndicatorKind, value: string): boolean {
  return kind === "DOMAIN" && value.trim().startsWith("*.");
}

/**
 * A stable id for an indicator.
 *
 * Derived rather than random, so re-ingesting the same feed is an update instead of a
 * second copy. That is what makes a feed safe to poll on a schedule — the property the
 * `from-ticket-<ref>` tag gives Tix's outcome sweep, for the same reason.
 *
 * One consequence, stated because it is a choice rather than an accident: the id does not
 * include the feed, so two feeds naming one address are **one row**, and the most recent feed
 * to name it owns the provenance on it. That is the honest reading of a single `source`
 * column — a list would be more precise and would also make "withdraw it for this feed" a
 * question with two answers, which is worse at the moment somebody is turning a bad feed off.
 */
export function indicatorId(kind: IndicatorKind, value: string): string {
  const canonical = canonicalValue(kind, value);
  let hash = 0;
  const input = `${kind}|${canonical}`;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return `${kind.toLowerCase()}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export interface IndicatorIssue {
  field: string;
  message: string;
}

/**
 * A feed row → an indicator, or the reasons it is not one.
 *
 * `source` is required and is never defaulted: an indicator whose provenance is unknown
 * cannot be withdrawn when the feed turns out to be wrong, and "which feed told us this?"
 * is the first question asked about a false positive.
 */
export function parseIndicator(
  input: { value?: unknown; kind?: unknown; source?: unknown; confidence?: unknown; severity?: unknown; labels?: unknown; expiresAt?: unknown },
  context: { at: number },
): { ok: true; indicator: Indicator } | { ok: false; issues: IndicatorIssue[] } {
  const issues: IndicatorIssue[] = [];
  const rawValue = typeof input.value === "string" ? input.value.trim() : "";
  const source = typeof input.source === "string" ? input.source.trim() : "";
  if (!rawValue) issues.push({ field: "value", message: "an indicator needs a value" });
  if (!source) issues.push({ field: "source", message: "an indicator needs the feed it came from" });
  if (issues.length > 0) return { ok: false, issues };

  const statedKind = typeof input.kind === "string" ? input.kind.toUpperCase() : "";
  const kind = (INDICATOR_KINDS as readonly string[]).includes(statedKind)
    ? (statedKind as IndicatorKind)
    : classifyIndicator(rawValue);
  if (!kind) {
    return { ok: false, issues: [{ field: "value", message: `“${rawValue}” is not a value this can watch` }] };
  }
  // A stated kind that disagrees with the value is refused rather than trusted: a feed that
  // labels an address as a domain has a bug, and silently re-labelling it would hide it.
  const inferred = classifyIndicator(rawValue.replace(/^\*\./, ""));
  if (statedKind && inferred && inferred !== kind && !(kind === "DOMAIN" && inferred === "DOMAIN")) {
    issues.push({ field: "kind", message: `“${rawValue}” is a ${inferred}, not a ${kind}` });
  }

  const confidence = typeof input.confidence === "number" && Number.isFinite(input.confidence)
    ? Math.max(0, Math.min(100, Math.round(input.confidence)))
    : CONFIDENCE_FLOOR;
  const severity = typeof input.severity === "string" && ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(input.severity.toUpperCase())
    ? (input.severity.toUpperCase() as Severity)
    : null;
  const labels = Array.isArray(input.labels) ? input.labels.filter((l): l is string => typeof l === "string") : [];
  const expiresAt = typeof input.expiresAt === "number" && Number.isFinite(input.expiresAt)
    ? input.expiresAt
    : null;

  if (issues.length > 0) return { ok: false, issues };

  const canonical = canonicalValue(kind, rawValue);
  return {
    ok: true,
    indicator: {
      id: indicatorId(kind, rawValue),
      kind,
      value: canonical,
      wildcard: isWildcard(kind, rawValue),
      source,
      confidence,
      severity,
      labels,
      expiresAt,
      firstSeenAt: context.at,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  The line format                                                           */
/* -------------------------------------------------------------------------- */

/** One row read out of a feed's text, before anything has judged it an indicator. */
export interface FeedRow {
  value: string;
  confidence?: number;
  severity?: string;
  /** Epoch ms. */
  expiresAt?: number;
}

/** A line that could not be read as a row, with the line's own text for the report. */
export interface FeedLineIssue {
  /** 1-based, so it matches what an editor shows. */
  line: number;
  raw: string;
  reason: string;
}

/**
 * Parse the plain-text feed format: one indicator per line, `|`-separated fields.
 *
 * ```
 *   203.0.113.9
 *   *.bad.example | 80
 *   8c1b…c3 | | CRITICAL | 2027-01-01
 * ```
 *
 * Four decisions, all of them about what an operator pasting a feed into a box deserves:
 *
 *  - **`|` separates, not a comma.** A URL can contain a comma and a CIDR cannot contain a
 *    pipe, so the delimiter that cannot appear in the value is the one that is safe.
 *  - **A blank line and a `#` comment are skipped, not refused.** A feed file with a header
 *    is a normal feed file, and reporting its comments as bad rows would train an operator
 *    to ignore the refusal list.
 *  - **A field may be left empty.** `value || CRITICAL` sets the severity and does not set a
 *    confidence, because that is what the person meant and refusing it would make the format
 *    positional in a way nobody reads.
 *  - **A bad *field* is reported by line and the row is dropped; a bad *value* is left for
 *    `parseIndicator`.** The two halves refuse different things — this one knows whether a
 *    date parses, the other knows whether a value is an address — and neither guesses about
 *    the other's half.
 *
 * `expires` accepts an ISO instant or a bare `YYYY-MM-DD`, and a bare date means *the end of
 * that day*: "expires 2027-01-01" is how a person writes "stop using it after the 1st", and
 * reading it as midnight at the *start* of the day would withdraw the indicator a day early.
 */
export function parseFeedLines(text: string): { rows: FeedRow[]; issues: FeedLineIssue[] } {
  const rows: FeedRow[] = [];
  const issues: FeedLineIssue[] = [];

  const lines = (text ?? "").split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = index + 1;
    const raw = rawLine.trim();
    if (raw.length === 0 || raw.startsWith("#")) return;

    const [value = "", confidence = "", severity = "", expires = ""] = raw.split("|").map((part) => part.trim());
    if (value.length === 0) {
      issues.push({ line, raw, reason: "no value before the first separator" });
      return;
    }

    const row: FeedRow = { value };

    if (confidence.length > 0) {
      const parsed = Number(confidence);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        issues.push({ line, raw, reason: `“${confidence}” is not a confidence between 0 and 100` });
        return;
      }
      row.confidence = Math.round(parsed);
    }

    if (severity.length > 0) {
      const wanted = severity.toUpperCase();
      if (!["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(wanted)) {
        issues.push({ line, raw, reason: `“${severity}” is not one of LOW, MEDIUM, HIGH, CRITICAL` });
        return;
      }
      row.severity = wanted;
    }

    if (expires.length > 0) {
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(expires)
        ? Date.parse(`${expires}T23:59:59.999Z`)
        : Date.parse(expires);
      if (Number.isNaN(parsed)) {
        issues.push({ line, raw, reason: `“${expires}” is not a date or an ISO instant` });
        return;
      }
      row.expiresAt = parsed;
    }

    rows.push(row);
  });

  return { rows, issues };
}

/** Whether an indicator may still be used, at a given instant. */
export function isActive(indicator: Indicator, at: number): boolean {
  return indicator.expiresAt === null || indicator.expiresAt > at;
}

/* -------------------------------------------------------------------------- */
/*  Matching                                                                  */
/* -------------------------------------------------------------------------- */

/** The host part of a URL, lowercased; `null` when the value is not a URL. */
export function hostOfUrl(value: string): string | null {
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(value.trim());
  if (!match) return null;
  // Strip credentials: a feed lists hosts, not `user:pass@host:8443`.
  const authority = match[1];
  const afterAt = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  // A bracketed literal address ends at its `]` — splitting on the first colon would turn
  // `[2001:db8::1]:80` into `2001`, which matches no indicator and looks like a near miss.
  if (afterAt.startsWith("[")) {
    const end = afterAt.indexOf("]");
    return (end === -1 ? afterAt.slice(1) : afterAt.slice(1, end)).toLowerCase();
  }
  return afterAt.split(":")[0].toLowerCase();
}

/** Exact, or under a `*.` indicator. Never a substring. */
export function domainMatches(host: string, indicator: Indicator): boolean {
  const candidate = host.toLowerCase().replace(/\.$/, "");
  if (!indicator.wildcard) return candidate === indicator.value;
  const bare = indicator.value.replace(/^\*\./, "");
  return candidate === bare || candidate.endsWith(`.${bare}`);
}

/** The attribute names a sensor uses for a URL, in the order they are preferred. */
const URL_ATTRIBUTES = ["url", "uri", "requestUrl", "request_url", "httpUrl"];
/** The attribute names a sensor uses for a file hash. */
const HASH_ATTRIBUTES = ["hash", "sha256", "sha1", "md5", "fileHash", "file_hash", "md5Hash"];

/**
 * Whether an indicator is about this observation, and where.
 *
 * The returned field is what lets the alert read "destination 45.x.x.x matched
 * `malware-c2` from feed-x" instead of just "threat intel hit", and it is why this returns
 * a match object rather than a boolean.
 */
export function matchEvent(event: ObservedEvent, indicator: Indicator, at: number): IndicatorMatch | null {
  if (!isActive(indicator, at)) return null;
  const escalates = indicator.confidence >= CONFIDENCE_FLOOR;

  switch (indicator.kind) {
    case "IPV4":
    case "IPV6":
    case "CIDR": {
      const inBlock = (address: string | null): boolean => {
        if (!address) return false;
        if (indicator.kind === "CIDR") return inCidr(address, indicator.value);
        return address.toLowerCase() === indicator.value;
      };
      if (inBlock(event.sourceAddress)) {
        return { indicator, field: "sourceAddress", attribute: null, observable: event.sourceAddress!, escalates };
      }
      if (inBlock(event.destinationAddress)) {
        return { indicator, field: "destinationAddress", attribute: null, observable: event.destinationAddress!, escalates };
      }
      // An address a host sensor put in the attributes counts too: a DNS query log names
      // the resolver in its fields, not in the five-tuple.
      for (const [name, value] of Object.entries(event.attributes)) {
        if (indicator.kind === "CIDR" ? inCidr(value, indicator.value) : value.toLowerCase() === indicator.value) {
          return { indicator, field: "attribute", attribute: name, observable: value, escalates };
        }
      }
      return null;
    }

    case "DOMAIN":
    case "URL": {
      for (const name of URL_ATTRIBUTES) {
        const value = event.attributes[name];
        if (!value) continue;
        const host = hostOfUrl(value);
        if (!host) continue;
        if (indicator.kind === "DOMAIN" && domainMatches(host, indicator)) {
          return { indicator, field: "attribute", attribute: name, observable: value, escalates };
        }
        if (indicator.kind === "URL" && value.toLowerCase().startsWith(canonicalValue("URL", indicator.value))) {
          return { indicator, field: "attribute", attribute: name, observable: value, escalates };
        }
      }
      // A host name the sensor recorded on its own, e.g. a TLS SNI or a DNS question.
      for (const name of ["domain", "hostname", "sni", "query", "dnsQuestion"]) {
        const value = event.attributes[name];
        if (value && indicator.kind === "DOMAIN" && domainMatches(value, indicator)) {
          return { indicator, field: "attribute", attribute: name, observable: value, escalates };
        }
      }
      return null;
    }

    default: {
      // A digest: compared against the hash-shaped attributes, and against any attribute
      // whose value is exactly the digest — a sensor that named its field something this
      // module has never heard of still gets the match.
      for (const name of HASH_ATTRIBUTES) {
        const value = event.attributes[name];
        if (value && value.toLowerCase() === indicator.value) {
          return { indicator, field: "attribute", attribute: name, observable: value, escalates };
        }
      }
      for (const [name, value] of Object.entries(event.attributes)) {
        if (value.toLowerCase() === indicator.value) {
          return { indicator, field: "attribute", attribute: name, observable: value, escalates };
        }
      }
      return null;
    }
  }
}

/** Every indicator an observation matches, most confident first. */
export function matchIndicators(
  event: ObservedEvent,
  indicators: readonly Indicator[],
  at: number,
): IndicatorMatch[] {
  const matches: IndicatorMatch[] = [];
  for (const indicator of indicators) {
    const match = matchEvent(event, indicator, at);
    if (match) matches.push(match);
  }
  // Deduplicated per indicator: one event cannot match the same indicator twice, and a
  // list with a repeat would otherwise be reported twice in the alert.
  const seen = new Set<string>();
  return matches
    .filter((match) => (seen.has(match.indicator.id) ? false : (seen.add(match.indicator.id), true)))
    .sort((a, b) => b.indicator.confidence - a.indicator.confidence || a.indicator.id.localeCompare(b.indicator.id));
}

/** Every indicator a batch of observations matches, keyed by the event's identity. */
export function matchEvents(
  events: readonly ObservedEvent[],
  indicators: readonly Indicator[],
  at: number,
): Map<ObservedEvent, IndicatorMatch[]> {
  const out = new Map<ObservedEvent, IndicatorMatch[]>();
  for (const event of events) {
    const matches = matchIndicators(event, indicators, at);
    if (matches.length > 0) out.set(event, matches);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  What a match does                                                         */
/* -------------------------------------------------------------------------- */

const SEVERITY_ORDER: readonly Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

/** The higher of two severities. */
export function maxSeverity(left: Severity, right: Severity): Severity {
  return SEVERITY_ORDER.indexOf(right) > SEVERITY_ORDER.indexOf(left) ? right : left;
}

/**
 * The severity a detection is raised to, given what a feed knows about it.
 *
 * Only matches above the confidence floor count, and a feed's own severity is only ever a
 * *floor* — it can raise what a rule fired at, never lower it. A feed that says "LOW" about
 * an address the deployment's own rule called CRITICAL is not evidence for a downgrade;
 * the rule saw the behaviour and the feed has only read about the address.
 */
export function escalateSeverity(severity: Severity, matches: readonly IndicatorMatch[]): Severity {
  let result = severity;
  for (const match of matches) {
    if (!match.escalates) continue;
    // A feed with its own opinion sets a floor; one without still says "somebody has
    // already met this address", which is worth at least HIGH out of a LOW or a MEDIUM.
    if (match.indicator.severity) result = maxSeverity(result, match.indicator.severity);
    else if (result === "LOW" || result === "MEDIUM") result = "HIGH";
  }
  return result;
}

/**
 * The one-line reason an alert's severity moved, or `null` when nothing escalated.
 *
 * Kept separate from the escalation itself so the alert can be read without recomputing
 * anything, and so a test can assert the sentence an operator will see.
 */
export function escalationReason(matches: readonly IndicatorMatch[]): string | null {
  const escalating = matches.filter((match) => match.escalates);
  if (escalating.length === 0) return null;
  const worst = escalating[0];
  const more = escalating.length - 1;
  return `${worst.indicator.value} matched an indicator from ${worst.indicator.source} (confidence ${worst.indicator.confidence})` +
    (more > 0 ? `, and ${more} more` : "");
}

/** A short sentence naming the feeds involved, for a list view. */
export function matchSummary(matches: readonly IndicatorMatch[]): string | null {
  if (matches.length === 0) return null;
  const feeds = [...new Set(matches.map((match) => match.indicator.source))];
  return `${matches.length} indicator(s) from ${feeds.join(", ")}`;
}
