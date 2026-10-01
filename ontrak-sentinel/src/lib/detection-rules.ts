/**
 * Detection rules (S3): the rules, as data, and the function that applies them.
 *
 * A rule is a value rather than a function on purpose. A rule that is data can be
 * versioned, compared, shown to a reviewer, and — the reason this milestone exists —
 * *tested*: the harness that fires a rule is the same `evaluateRules` the pipeline calls,
 * so "the rule works" is a claim about the code that runs rather than about a copy of it
 * in a test file.
 *
 * Three shapes cover what a first release actually needs, and no more:
 *
 *  - **signature** — one observation that is bad by itself (a telnet connection to a
 *    production subnet). Cheap, and exactly as good as its match is specific.
 *  - **behavioural threshold** — one source doing a thing too many times in a window (a
 *    scan, a credential spray). The count and the window are on the rule, so the number
 *    that fired is in the alert rather than in somebody's memory.
 *  - **sequence** — a pattern in order (five failures and then a success, from one
 *    address). This is the shape that needs *identity* to mean anything, and it is why
 *    correlation lives beside detection rather than after it.
 *
 * Decisions worth stating out loud:
 *
 *  - **A rule never fires twice for the same evidence.** A group that matches a threshold
 *    produces one alert keyed on the group and the window, so a hundred packets are one
 *    incident. The alternative — an alert per packet — is how a detection platform gets
 *    switched off.
 *  - **`groupBy` is part of the rule, not a global.** "Too many from one address" and "too
 *    many to one server" are different questions, and a platform that chose for you would
 *    answer the one nobody asked.
 *  - **Evidence is carried, not referenced.** The alert keeps the observations it was
 *    built from, because a rule that fired at 03:00 and an operator reading it at 09:00
 *    cannot both be looking at a rotating log buffer.
 */

import { sha256Hex } from "./hash";
import {
  dedupeKey,
  deviceOf,
  assetOf,
  type ObservedEvent,
  type TrafficDirection,
} from "./telemetry-rules";

export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type GroupKey = "sourceAddress" | "destinationAddress" | "sourceAddressAndPort";

export interface SignatureMatch {
  /** Destination ports the observation must be to. Empty or absent means any. */
  destinationPorts?: readonly number[];
  protocol?: string;
  direction?: TrafficDirection;
  /** Source addresses inside any of these CIDR blocks (IPv4) or exactly equal (IPv6). */
  sourceAddressInCidr?: readonly string[];
  destinationAddressInCidr?: readonly string[];
  /** Attribute name → value the observation must carry. All of them must match. */
  attributeEquals?: Record<string, string>;
}

export interface ThresholdMatch {
  count: number;
  windowMs: number;
  groupBy: GroupKey;
  /** Narrow the events the count is taken over. */
  where?: SignatureMatch;
}

export interface SequenceStep {
  /** Attribute name → value this step's observation must carry. */
  attributeEquals: Record<string, string>;
}

export interface SequenceMatch {
  steps: readonly SequenceStep[];
  windowMs: number;
  groupBy: GroupKey;
  where?: SignatureMatch;
}

export type DetectionShape =
  | { kind: "signature"; match: SignatureMatch }
  | { kind: "behavioural"; match: ThresholdMatch }
  | { kind: "sequence"; match: SequenceMatch };

export interface DetectionRule {
  id: string;
  /** Bumped whenever the match changes, so an alert says which rule *version* fired. */
  version: number;
  name: string;
  severity: Severity;
  /** One sentence an on-call engineer reads first. */
  description: string;
  /** The mapping a deployment cares about, e.g. `MITRE:T1110`. Free text on purpose. */
  references: readonly string[];
  /** Which observations the rule even looks at. */
  appliesTo: { kinds?: readonly string[]; sources?: readonly string[] };
  detection: DetectionShape;
}

/** A rule that fired. The service fills in identity, device and asset. */
export interface AlertDraft {
  ruleId: string;
  ruleVersion: number;
  ruleName: string;
  severity: Severity;
  /** Stable for the same evidence, so a re-run does not raise a second alert. */
  dedupeKey: string;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrences: number;
  groupKey: string;
  evidence: ObservedEvent[];
}

/* -------------------------------------------------------------------------- */
/*  Address matching                                                          */
/* -------------------------------------------------------------------------- */

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/**
 * Whether an address is inside a CIDR block.
 *
 * IPv4 blocks are compared numerically; an IPv6 address is only ever matched exactly, and
 * an IPv6 *block* is refused rather than half-implemented — a rule that silently matched
 * nothing would read as a rule that found nothing.
 */
export function inCidr(address: string, cidr: string): boolean {
  const [network, bits] = cidr.split("/");
  const networkValue = ipv4ToInt(network);
  const addressValue = ipv4ToInt(address);
  if (networkValue === null || addressValue === null) return address === network;
  const prefix = bits === undefined ? 32 : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressValue & mask) === (networkValue & mask);
}

/* -------------------------------------------------------------------------- */
/*  Matching                                                                  */
/* -------------------------------------------------------------------------- */

function matchesWhere(event: ObservedEvent, match: SignatureMatch): boolean {
  if (match.destinationPorts && match.destinationPorts.length > 0) {
    if (event.destinationPort === null || !match.destinationPorts.includes(event.destinationPort)) return false;
  }
  if (match.protocol && event.protocol !== match.protocol.toLowerCase()) return false;
  if (match.direction && event.direction !== match.direction) return false;
  if (match.sourceAddressInCidr) {
    if (!event.sourceAddress || !match.sourceAddressInCidr.some((cidr) => inCidr(event.sourceAddress!, cidr))) return false;
  }
  if (match.destinationAddressInCidr) {
    if (!event.destinationAddress || !match.destinationAddressInCidr.some((cidr) => inCidr(event.destinationAddress!, cidr))) return false;
  }
  if (match.attributeEquals) {
    for (const [key, value] of Object.entries(match.attributeEquals)) {
      if (event.attributes[key] !== value) return false;
    }
  }
  return true;
}

function groupValue(event: ObservedEvent, groupBy: GroupKey): string {
  switch (groupBy) {
    case "sourceAddress":
      return event.sourceAddress ?? "-";
    case "destinationAddress":
      return event.destinationAddress ?? "-";
    case "sourceAddressAndPort":
      return `${event.sourceAddress ?? "-"}:${event.sourcePort ?? "-"}`;
  }
}

/** Whether the rule is even interested in this observation. */
export function ruleApplies(rule: DetectionRule, event: ObservedEvent): boolean {
  if (rule.appliesTo.kinds && !rule.appliesTo.kinds.includes(event.kind)) return false;
  if (rule.appliesTo.sources && !rule.appliesTo.sources.includes(event.source)) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/*  The rules                                                                 */
/* -------------------------------------------------------------------------- */

/** Egress to a management/plaintext service that should never be reachable in production. */
export const SUSPICIOUS_SERVICE_RULE: DetectionRule = {
  id: "SG-SIG-001",
  version: 1,
  name: "Connection to a plaintext management service",
  severity: "HIGH",
  description:
    "A connection to telnet or an alternate management port. Telnet carries credentials in the clear, and a service like it on a production network is either something nobody documented or something somebody installed.",
  references: ["MITRE:T1021", "CIS:4.1"],
  appliesTo: { kinds: ["NETWORK"] },
  detection: {
    kind: "signature",
    match: { destinationPorts: [23, 2323, 512, 513, 514], direction: "OUTBOUND" },
  },
};

/** One source hammering one port: the shape of a scan or a spray, regardless of outcome. */
export const SCAN_RULE: DetectionRule = {
  id: "SG-BEH-001",
  version: 1,
  name: "Repeated connections from one source to one port",
  severity: "MEDIUM",
  description:
    "One address opened many connections to the same port inside one minute. That is the shape of a port scan that found something, a brute-force attempt, or a misconfigured retry loop — and the count is on the alert so the reader can tell which.",
  references: ["MITRE:T1046"],
  appliesTo: { kinds: ["NETWORK"] },
  detection: {
    kind: "behavioural",
    match: { count: 20, windowMs: 60_000, groupBy: "sourceAddress", where: { direction: "LATERAL" } },
  },
};

/**
 * The identity-aware one: authentication failures followed by a success from one address.
 *
 * This is the reason detection and identity live in one product. On a network alone it is
 * "some failures"; with a session joined to the address it is *who* signed in after being
 * guessed at, which is the difference between a dashboard and an incident.
 */
export const CREDENTIAL_STUFFING_RULE: DetectionRule = {
  id: "SG-BEH-002",
  version: 1,
  name: "Failed sign-ins followed by a success from one address",
  severity: "CRITICAL",
  description:
    "Five authentication failures and then an accepted one from the same address. Either somebody guessed correctly or a valid credential is in the wrong hands; both need a person, and the alert names them when the address matches a session.",
  references: ["MITRE:T1110", "MITRE:T1078"],
  appliesTo: { kinds: ["AUTH"] },
  detection: {
    kind: "sequence",
    match: {
      groupBy: "sourceAddress",
      windowMs: 10 * 60_000,
      steps: [
        { attributeEquals: { outcome: "failure" } },
        { attributeEquals: { outcome: "failure" } },
        { attributeEquals: { outcome: "failure" } },
        { attributeEquals: { outcome: "failure" } },
        { attributeEquals: { outcome: "failure" } },
        { attributeEquals: { outcome: "success" } },
      ],
    },
  },
};

/**
 * The rules this build ships.
 *
 * A list rather than a registry object, because the order is not meaningful and a list is
 * what a test iterates over to check that every rule has an id, a version and a
 * description — the harness that keeps a rule from arriving undocumented.
 */
export const DETECTION_RULES: readonly DetectionRule[] = [
  SUSPICIOUS_SERVICE_RULE,
  SCAN_RULE,
  CREDENTIAL_STUFFING_RULE,
];

/**
 * A name for the **rule set as a whole**, and therefore for the code that judged a batch.
 *
 * A per-rule `version` answers "which version of *this* rule fired" and is already on every
 * alert. What it does not answer is the other half of "why did this fire last Tuesday":
 * *which corpus was running?* Two rules can both be at version 1 while the set around them
 * changed — a rule added, a rule removed, a window widened — and an alert read six weeks
 * later has no way to say which of those happened.
 *
 * So the set gets its own id: a digest over each rule's id, version, severity and detection
 * shape. Three properties are the point. **It is order-independent** (the list's order is
 * not meaningful and a reordering is not a change), so the digest moves only when the
 * corpus really does. **It digests the *shape*, not just the declared version** — so a
 * matcher edited without bumping `version` still moves the id, which is exactly the silent
 * change the per-rule version cannot catch by itself; a rule that changes *must* bump its
 * version, and this makes forgetting visible rather than invisible. And **it is short and
 * derived**, so a deployment can report it, a test can pin it, and nothing has to be stored
 * to compute it.
 *
 * What it is not: a signature. It is a fingerprint of what ran, not a tamper-proof seal — a
 * deployment that needs the latter has the hash-chained evidence log.
 */
export function rulebookVersion(rules: readonly DetectionRule[] = DETECTION_RULES): string {
  const lines = rules
    .map(
      (rule) =>
        `${rule.id}@${rule.version}|${rule.severity}|${rule.detection.kind}|${JSON.stringify(rule.detection.match)}`,
    )
    .sort();
  return sha256Hex(lines.join("\n")).slice(0, 12);
}

/* -------------------------------------------------------------------------- */
/*  Evaluation                                                                */
/* -------------------------------------------------------------------------- */

/** One alert per group and window, so a hundred packets are one incident. */
function windowKey(rule: DetectionRule, group: string, at: number, windowMs: number): string {
  return `${rule.id}@${rule.version}|${group}|${Math.floor(at / windowMs)}`;
}

function draft(rule: DetectionRule, group: string, key: string, evidence: ObservedEvent[]): AlertDraft {
  const ordered = [...evidence].sort((a, b) => a.at - b.at);
  return {
    ruleId: rule.id,
    ruleVersion: rule.version,
    ruleName: rule.name,
    severity: rule.severity,
    dedupeKey: key,
    firstSeenAt: ordered[0].at,
    lastSeenAt: ordered[ordered.length - 1].at,
    occurrences: ordered.length,
    groupKey: group,
    evidence: ordered,
  };
}

/**
 * Apply every rule to a batch of observations.
 *
 * Total and pure: no clock, no store, no network. The pipeline hands it a batch and gets
 * back the alerts that batch produced, so "why did this fire?" is a question a test can
 * answer by calling this function with the same events.
 */
export function evaluateRules(
  events: readonly ObservedEvent[],
  rules: readonly DetectionRule[] = DETECTION_RULES,
): AlertDraft[] {
  const drafts: AlertDraft[] = [];

  for (const rule of rules) {
    const considered = events.filter((event) => ruleApplies(rule, event));

    if (rule.detection.kind === "signature") {
      for (const event of considered) {
        if (!matchesWhere(event, rule.detection.match)) continue;
        // One alert per observation, keyed on the observation itself: a signature is bad
        // by itself, so two telnet connections are two alerts and a re-send is one.
        const group = groupValue(event, "destinationAddress");
        drafts.push(draft(rule, group, windowKey(rule, `${group}|${dedupeKey(event)}`, event.at, 60_000), [event]));
      }
      continue;
    }

    if (rule.detection.kind === "behavioural") {
      const { count, windowMs, groupBy, where } = rule.detection.match;
      const groups = new Map<string, ObservedEvent[]>();
      for (const event of considered) {
        if (where && !matchesWhere(event, where)) continue;
        const group = groupValue(event, groupBy);
        groups.set(group, [...(groups.get(group) ?? []), event]);
      }
      for (const [group, inGroup] of groups) {
        const ordered = [...inGroup].sort((a, b) => a.at - b.at);
        // A sliding window rather than a fixed bucket: a burst that straddles a bucket
        // boundary is still one burst, and a rule that missed it would be a rule that
        // works until it matters.
        for (let start = 0; start < ordered.length; start += 1) {
          const window = ordered.filter((event) => event.at >= ordered[start].at && event.at <= ordered[start].at + windowMs);
          if (window.length < count) continue;
          drafts.push(draft(rule, group, windowKey(rule, group, ordered[start].at, windowMs), window));
          break;
        }
      }
      continue;
    }

    const { steps, windowMs, groupBy, where } = rule.detection.match;
    const groups = new Map<string, ObservedEvent[]>();
    for (const event of considered) {
      if (where && !matchesWhere(event, where)) continue;
      const group = groupValue(event, groupBy);
      groups.set(group, [...(groups.get(group) ?? []), event]);
    }
    for (const [group, inGroup] of groups) {
      const ordered = [...inGroup].sort((a, b) => a.at - b.at);
      for (let start = 0; start < ordered.length; start += 1) {
        const matched: ObservedEvent[] = [];
        let cursor = start;
        for (const step of steps) {
          let found: ObservedEvent | null = null;
          while (cursor < ordered.length) {
            const candidate = ordered[cursor];
            cursor += 1;
            if (candidate.at - ordered[start].at > windowMs) break;
            if (Object.entries(step.attributeEquals).every(([key, value]) => candidate.attributes[key] === value)) {
              found = candidate;
              break;
            }
          }
          if (!found) break;
          matched.push(found);
        }
        if (matched.length !== steps.length) continue;
        drafts.push(draft(rule, group, windowKey(rule, group, ordered[start].at, windowMs), matched));
        break;
      }
    }
  }

  // Stable order, so a batch of alerts is the same list every time it is produced.
  return drafts.sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.ruleId.localeCompare(b.ruleId));
}

/** The device and asset an alert's evidence names, for the alert row. */
export function locationOf(draft_: AlertDraft): { device: string | null; asset: string | null } {
  const first = draft_.evidence[0];
  return { device: deviceOf(first), asset: assetOf(first) };
}
