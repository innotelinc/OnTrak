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
  /**
   * Attribute name → a set of values, any one of which matches. All names must match.
   *
   * The `OR` beside `attributeEquals`'s `AND`, and it exists because some facts are
   * naturally a *set*: the process names that dump credentials, the web-shell paths, the
   * startup mechanisms. Spelling those as one `attributeEquals` per member would be a rule
   * per synonym, and a rulebook that grows a row whenever somebody learns a new tool name
   * is a rulebook nobody reads.
   */
  attributeIn?: Record<string, readonly string[]>;
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

/**
 * The measure an anomaly rule watches inside each window.
 *
 * Deliberately a small, named vocabulary rather than a free-form expression: each one is a
 * count a sensor's telemetry already supports, and a rule names *which* count anomalous —
 * "too many events" and "too many destinations" are different shapes of attack and a
 * detector that chose for the reader would answer the question nobody asked.
 */
export type AnomalyMetric = "eventCount" | "distinctDestinations" | "distinctDestinationPorts";

/**
 * A statistical anomaly: a window whose measure is far from *this group's own* baseline.
 *
 * This is the one shape that is not a hand-written predicate. It learns each group's normal
 * from the observations in the batch — a **robust** baseline, so a single loud window does
 * not drag the centre toward itself and hide the thing it is supposed to find — and fires
 * when a window sits `sigma` robust standard deviations above it. Three guards keep it from
 * being a noise generator: `minSamples` windows of history must exist before it will speak
 * at all, `minValue` is an absolute floor so a burst of two is never "anomalous", and
 * `where` narrows what is even counted (outbound only, a host only).
 *
 * The default `sigma` is 3, read as a modified z-score: with a normal-ish distribution that
 * is roughly the 99.9th percentile, which is the point — an anomaly rule is allowed to be
 * quiet for a long time.
 */
export interface AnomalyMatch {
  metric: AnomalyMetric;
  /** The width of one comparison window, and how anomalies are bucketed. */
  windowMs: number;
  groupBy: GroupKey;
  /** Robust standard deviations above the group's median before this fires. */
  sigma: number;
  /** How many windows of history the baseline needs before the rule may speak. */
  minSamples: number;
  /** An absolute floor: a value under this is never anomalous, however far above zero. */
  minValue: number;
  where?: SignatureMatch;
}

export type DetectionShape =
  | { kind: "signature"; match: SignatureMatch }
  | { kind: "behavioural"; match: ThresholdMatch }
  | { kind: "sequence"; match: SequenceMatch }
  | { kind: "anomaly"; match: AnomalyMatch };

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
  if (match.attributeIn) {
    for (const [key, values] of Object.entries(match.attributeIn)) {
      const actual = event.attributes[key];
      if (actual === undefined || !values.includes(actual)) return false;
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

/** The middle value, the robust half of the anomaly baseline. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The mean absolute deviation, the fallback scale when the median one is zero. */
function meanAbsoluteDeviation(values: readonly number[], center: number): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + Math.abs(value - center), 0) / values.length;
}

/** The measure an anomaly rule watches, taken over one window's observations. */
function anomalyMetricValue(metric: AnomalyMetric, events: readonly ObservedEvent[]): number {
  if (metric === "eventCount") return events.length;
  if (metric === "distinctDestinations") {
    return new Set(events.map((event) => event.destinationAddress).filter((value): value is string => value !== null)).size;
  }
  return new Set(events.map((event) => event.destinationPort).filter((value): value is number => value !== null)).size;
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
 * A remote-access or remote-desktop port answered from outside the network.
 *
 * RDP and VNC in from the perimeter is the single most exploited exposed service there is,
 * and it is a *configuration* finding as much as an intrusion one: either somebody meant to
 * publish it or nobody noticed, and both need a person today.
 */
export const EXPOSED_REMOTE_DESKTOP_RULE: DetectionRule = {
  id: "SG-SIG-002",
  version: 1,
  name: "Remote desktop exposed to the perimeter",
  severity: "HIGH",
  description:
    "An inbound connection to RDP or VNC from outside the network. A remote-desktop service reachable from the internet is the most-attacked exposed service there is; whether it was meant to be published or was never noticed, it needs a person.",
  references: ["MITRE:T1133", "CIS:9.3"],
  appliesTo: { kinds: ["NETWORK"] },
  detection: {
    kind: "signature",
    match: { destinationPorts: [3389, 5900, 5901], direction: "INBOUND" },
  },
};

/**
 * One source sweeping east-west management ports — WinRM, RPC and RDP between hosts.
 *
 * A threshold rather than a signature on purpose: a *single* SMB or RPC connection between
 * two servers is ordinary, and a rule that fired on one would fire on the file server all day.
 * What is not ordinary is one host reaching those ports ten times in a minute, which is what
 * a lateral sweep looks like, so that is what this counts.
 */
export const LATERAL_ADMIN_RULE: DetectionRule = {
  id: "SG-BEH-004",
  version: 1,
  name: "Lateral sweep to administrative services",
  severity: "MEDIUM",
  description:
    "Ten east-west connections from one source to remote-management ports inside a minute. A single such connection is normal file-share or RPC traffic; ten from one host is a sweep across the estate, and the alert names the source so a reader can see where it started.",
  references: ["MITRE:T1021.002", "MITRE:T1570"],
  appliesTo: { kinds: ["NETWORK"] },
  detection: {
    kind: "behavioural",
    match: {
      count: 10,
      windowMs: 60_000,
      groupBy: "sourceAddress",
      where: { destinationPorts: [135, 5985, 5986, 3389], direction: "LATERAL" },
    },
  },
};

/** A spray that never succeeds is still a spray: many failures from one address. */
export const AUTH_SPRAY_RULE: DetectionRule = {
  id: "SG-BEH-003",
  version: 1,
  name: "Repeated authentication failures from one address",
  severity: "MEDIUM",
  description:
    "Ten authentication failures from one address inside five minutes. This is the half the sequence rule deliberately does not cover — a spray that never lands — and it is worth a person's attention precisely because it says somebody is still trying.",
  references: ["MITRE:T1110", "MITRE:T1531"],
  appliesTo: { kinds: ["AUTH"] },
  detection: {
    kind: "behavioural",
    match: { count: 10, windowMs: 5 * 60_000, groupBy: "sourceAddress", where: { attributeEquals: { outcome: "failure" } } },
  },
};

/**
 * A tool whose only reason to run on a host is to steal credentials.
 *
 * A signature, not an anomaly: these names are not ambiguous, and a host running one is a
 * host whose secrets have to be treated as taken. Case is as the sensor reports it — an
 * agent that canonicalizes process names to lower case (as the shipped agent does) is what
 * makes this list short.
 */
export const CREDENTIAL_DUMPING_TOOL_RULE: DetectionRule = {
  id: "SG-HOST-001",
  version: 1,
  name: "Credential-dumping tool executed on a host",
  severity: "CRITICAL",
  description:
    "A process on a monitored host whose known purpose is to read credentials out of memory or the registry. There is no benign reading of this: treat the host's secrets as compromised and start containment.",
  references: ["MITRE:T1003", "MITRE:T1055"],
  appliesTo: { kinds: ["HOST"] },
  detection: {
    kind: "signature",
    match: {
      attributeIn: {
        process: [
          "mimikatz", "mimikatz.exe", "procdump", "procdump.exe", "secretsdump.py",
          "lazagne", "lazagne.exe", "gsecdump", "gsecdump.exe", "pwdump", "pwdump7.exe",
          "wce.exe", "ntdsutil.exe", "dsinternals",
        ],
      },
    },
  },
};

/** A web server that spawned an interactive shell: the signature of a dropped web shell. */
export const WEB_SERVER_SHELL_RULE: DetectionRule = {
  id: "SG-HOST-002",
  version: 1,
  name: "A web-server process spawned a shell",
  severity: "HIGH",
  description:
    "A shell whose parent is a web server or application server. A server process is not supposed to hand a person an interactive command line; when it does, something already reached it and this is the shell it left behind.",
  references: ["MITRE:T1190", "MITRE:T1059"],
  appliesTo: { kinds: ["HOST"] },
  detection: {
    kind: "signature",
    match: {
      attributeIn: {
        process: ["sh", "bash", "dash", "zsh", "cmd.exe", "powershell.exe", "pwsh.exe", "/bin/sh", "/bin/bash"],
        parentProcess: ["nginx", "apache2", "httpd", "w3wp.exe", "php-fpm", "tomcat", "node", "java", "caddy"],
      },
    },
  },
};

/** A new persistence mechanism appearing on a host. */
export const HOST_PERSISTENCE_RULE: DetectionRule = {
  id: "SG-HOST-003",
  version: 1,
  name: "A persistence mechanism was installed on a host",
  severity: "MEDIUM",
  description:
    "A scheduled task, a startup entry, a new service, an SSH authorized-key change or a cron line. Each is a legitimate administrative act and each is also how an intruder guarantees they come back; the alert names the host and the mechanism so a reader can check whether anybody asked for it.",
  references: ["MITRE:T1053", "MITRE:T1543", "MITRE:T1098"],
  appliesTo: { kinds: ["HOST"] },
  detection: {
    kind: "signature",
    match: {
      attributeIn: {
        event: [
          "scheduled_task_created", "startup_entry_added", "service_installed",
          "authorized_keys_changed", "cron_entry_added", "persistence",
        ],
      },
    },
  },
};

/** A request to a path that only a web shell or an exploit kit would ask for. */
export const WEB_SHELL_REQUEST_RULE: DetectionRule = {
  id: "SG-HTTP-001",
  version: 1,
  name: "Web-shell or exploit path requested",
  severity: "CRITICAL",
  description:
    "An HTTP request to a path that is a known web shell, a backup of one, or a scanner's probe. It may be a probe that found nothing, but the request is the reconnaissance half of an intrusion and the address that sent it is worth blocking.",
  references: ["MITRE:T1190", "MITRE:T1595"],
  appliesTo: { kinds: ["HTTP"] },
  detection: {
    kind: "signature",
    match: {
      attributeIn: {
        path: [
          "/shell.php", "/cmd.php", "/c99.php", "/r57.php", "/webshell.php", "/wso.php",
          "/wp-content/uploads/shell.php", "/.env", "/wp-config.php.bak", "/phpmyadmin/",
          "/actuator/env", "/console/login/LoginForm.jsp",
        ],
      },
    },
  },
};

/**
 * The statistical rules.
 *
 * Three baselines, and each exists because a hand-written threshold would be a guess: the
 * "too many" number for a health-check box is a Tuesday for a desktop, so the rule learns
 * the group's own normal instead of declaring one. They are the rules that catch the attack
 * nobody wrote a signature for — a machine quietly beaconing, a host that started listening
 * on something.
 */
export const CONNECTION_VOLUME_ANOMALY_RULE: DetectionRule = {
  id: "SG-ANM-001",
  version: 1,
  name: "Connection-volume anomaly from one source",
  severity: "HIGH",
  description:
    "A source whose connections in one minute are far above its own baseline. The count that is normal differs per host and per hour, so this rule learns the baseline from the batch rather than naming a number, and stays quiet until a window is statistically far from it.",
  references: ["MITRE:T1046", "MITRE:T1071"],
  appliesTo: { kinds: ["NETWORK"] },
  detection: {
    kind: "anomaly",
    match: { metric: "eventCount", windowMs: 60_000, groupBy: "sourceAddress", sigma: 3, minSamples: 8, minValue: 40 },
  },
};

export const DESTINATION_FANOUT_ANOMALY_RULE: DetectionRule = {
  id: "SG-ANM-002",
  version: 1,
  name: "Destination fan-out anomaly from one source",
  severity: "HIGH",
  description:
    "A source reaching far more distinct destinations in one minute than it normally does. This is the shape of a sweep or of beaconing rolled over many hosts, and it fires on the *diversity* rather than the volume, so a scanner that is quiet per-address is still seen.",
  references: ["MITRE:T1046", "MITRE:T1105"],
  appliesTo: { kinds: ["NETWORK"] },
  detection: {
    kind: "anomaly",
    match: { metric: "distinctDestinations", windowMs: 60_000, groupBy: "sourceAddress", sigma: 3, minSamples: 8, minValue: 15 },
  },
};

export const LISTENING_PORT_ANOMALY_RULE: DetectionRule = {
  id: "SG-ANM-003",
  version: 1,
  name: "New listening-port anomaly on one host",
  severity: "MEDIUM",
  description:
    "A host accepting connections on far more distinct ports in one minute than its own baseline. A new listener is how remote access is left behind; the rule learns how many listeners a host usually shows and flags the window where that changes.",
  references: ["MITRE:T1205", "MITRE:T1571"],
  appliesTo: { kinds: ["HOST"] },
  detection: {
    kind: "anomaly",
    match: {
      metric: "distinctDestinationPorts",
      windowMs: 60_000,
      groupBy: "sourceAddress",
      sigma: 3,
      minSamples: 8,
      minValue: 8,
      where: { direction: "INBOUND" },
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
  EXPOSED_REMOTE_DESKTOP_RULE,
  LATERAL_ADMIN_RULE,
  AUTH_SPRAY_RULE,
  CREDENTIAL_DUMPING_TOOL_RULE,
  WEB_SERVER_SHELL_RULE,
  HOST_PERSISTENCE_RULE,
  WEB_SHELL_REQUEST_RULE,
  CONNECTION_VOLUME_ANOMALY_RULE,
  DESTINATION_FANOUT_ANOMALY_RULE,
  LISTENING_PORT_ANOMALY_RULE,
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

    if (rule.detection.kind === "anomaly") {
      const { metric, windowMs, groupBy, sigma, minSamples, minValue, where } = rule.detection.match;
      const groups = new Map<string, ObservedEvent[]>();
      for (const event of considered) {
        if (where && !matchesWhere(event, where)) continue;
        const group = groupValue(event, groupBy);
        groups.set(group, [...(groups.get(group) ?? []), event]);
      }
      for (const [group, inGroup] of groups) {
        const buckets = new Map<number, ObservedEvent[]>();
        for (const event of inGroup) {
          const bucket = Math.floor(event.at / windowMs) * windowMs;
          buckets.set(bucket, [...(buckets.get(bucket) ?? []), event]);
        }
        // Not enough history to know what "normal" is: say nothing, which is the whole
        // discipline of an anomaly rule. A detector that spoke on four windows would be a
        // detector that cries wolf and gets switched off.
        if (buckets.size < minSamples) continue;
        const entries = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
        const values = entries.map(([, events]) => anomalyMetricValue(metric, events));
        for (let index = 0; index < entries.length; index += 1) {
          const [bucket, events] = entries[index];
          const value = anomalyMetricValue(metric, events);
          if (value < minValue) continue;
          // Leave this window *out* of its own baseline: including the loud one would drag
          // the centre toward it and hide the very thing the rule exists to find.
          const others = values.filter((_, other) => other !== index);
          const center = median(others);
          const mad = median(others.map((other) => Math.abs(other - center)));
          // The modified z-score's scale (MAD / 0.6745 ≈ 1σ for a normal distribution). When
          // the baseline is flat — MAD 0 — the mean deviation is the fallback, so a perfectly
          // steady stream still has to clear `minValue` rather than fire on a rounding error.
          const scale = mad > 0 ? mad / 0.6745 : meanAbsoluteDeviation(others, center);
          const z = scale > 0 ? (value - center) / scale : value > center ? Number.POSITIVE_INFINITY : 0;
          if (!(z >= sigma)) continue;
          drafts.push(draft(rule, group, windowKey(rule, group, bucket, windowMs), events));
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
