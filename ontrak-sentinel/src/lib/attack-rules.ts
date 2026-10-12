/**
 * MITRE ATT&CK mapping (S3): the free-text `MITRE:T1110` reference, made structured.
 *
 * Every shipped rule already carries `references`, and some of them name an ATT&CK
 * technique. That is enough for a human reading one rule's source and not enough for
 * anything else: a string is not a technique, a technique is not a tactic, and "are we
 * covered against credential access?" cannot be answered by grepping for `T1`.
 *
 * This module is the missing structure, and it is deliberately three separate,
 * boring functions rather than one clever one:
 *
 *  - **Parse** a reference list into `{ framework, code }` pairs. Anything that is not
 *    a reference is not silently dropped — an unparseable entry is reported, because a
 *    reference nobody can read is a reference that is not protecting anything.
 *  - **Resolve** a technique id against a curated catalog: this build knows which
 *    technique belongs to which tactic(s). An id the catalog does not carry is
 *    reported as *uncatalogued* rather than treated as no technique at all, which is
 *    the distinction that keeps a typo from reading as coverage.
 *  - **Roll up** a rulebook into per-tactic coverage, with the tactics no rule touches
 *    stated as gaps. The map is derived from the rules, never restated, so it cannot
 *    claim a tactic is watched when nothing watches it.
 *
 * Scope is stated plainly instead of implied: the catalog is **the subset of ATT&CK
 * this build's rules map onto**, not the full enterprise matrix. `catalogComplete` on
 * the report says so, so a reader is never told "14 of 14 tactics covered" without also
 * being told what the denominator is.
 */

import type { DetectionRule } from "./detection-rules";

/* -------------------------------------------------------------------------- */
/*  Tactics                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The Enterprise tactics, in the order ATT&CK lays them out.
 *
 * The order is the *kill chain*, not an alphabet — a report read top to bottom walks an
 * intrusion from scanning to impact, which is the order an analyst thinks in.
 */
export const ATTACK_TACTICS = [
  "reconnaissance",
  "resource-development",
  "initial-access",
  "execution",
  "persistence",
  "privilege-escalation",
  "defense-evasion",
  "credential-access",
  "discovery",
  "lateral-movement",
  "collection",
  "command-and-control",
  "exfiltration",
  "impact",
] as const;

export type AttackTactic = (typeof ATTACK_TACTICS)[number];

const TACTIC_TITLES: Record<AttackTactic, string> = {
  reconnaissance: "Reconnaissance",
  "resource-development": "Resource Development",
  "initial-access": "Initial Access",
  execution: "Execution",
  persistence: "Persistence",
  "privilege-escalation": "Privilege Escalation",
  "defense-evasion": "Defense Evasion",
  "credential-access": "Credential Access",
  discovery: "Discovery",
  "lateral-movement": "Lateral Movement",
  collection: "Collection",
  "command-and-control": "Command and Control",
  exfiltration: "Exfiltration",
  impact: "Impact",
};

export function tacticTitle(tactic: AttackTactic): string {
  return TACTIC_TITLES[tactic];
}

/* -------------------------------------------------------------------------- */
/*  The technique catalog                                                     */
/* -------------------------------------------------------------------------- */

export interface AttackTechnique {
  /** The ATT&CK technique id, without the `MITRE:` prefix. Sub-techniques included. */
  id: string;
  name: string;
  /** Every tactic this technique is filed under. One technique can serve several. */
  tactics: readonly AttackTactic[];
}

/**
 * The techniques this build's rules map onto.
 *
 * Kept short and honest on purpose. A catalog that listed the whole matrix would make
 * "which tactics are covered" a measure of the catalog rather than of the rulebook, and
 * every deployment would report the same flattering number.
 */
export const ATTACK_TECHNIQUES: readonly AttackTechnique[] = [
  { id: "T1595", name: "Active Scanning", tactics: ["reconnaissance"] },
  { id: "T1133", name: "External Remote Services", tactics: ["persistence", "initial-access"] },
  { id: "T1190", name: "Exploit Public-Facing Application", tactics: ["initial-access"] },
  { id: "T1078", name: "Valid Accounts", tactics: ["initial-access", "persistence", "privilege-escalation", "defense-evasion"] },
  { id: "T1059", name: "Command and Scripting Interpreter", tactics: ["execution"] },
  { id: "T1053", name: "Scheduled Task/Job", tactics: ["execution", "persistence", "privilege-escalation"] },
  { id: "T1543", name: "Create or Modify System Process", tactics: ["persistence", "privilege-escalation"] },
  { id: "T1098", name: "Account Manipulation", tactics: ["persistence", "privilege-escalation"] },
  { id: "T1205", name: "Traffic Signaling", tactics: ["persistence", "defense-evasion", "command-and-control"] },
  { id: "T1055", name: "Process Injection", tactics: ["defense-evasion", "privilege-escalation"] },
  { id: "T1003", name: "OS Credential Dumping", tactics: ["credential-access"] },
  { id: "T1110", name: "Brute Force", tactics: ["credential-access"] },
  { id: "T1046", name: "Network Service Discovery", tactics: ["discovery"] },
  { id: "T1021", name: "Remote Services", tactics: ["lateral-movement", "execution"] },
  { id: "T1021.002", name: "SMB/Windows Admin Shares", tactics: ["lateral-movement"] },
  { id: "T1570", name: "Lateral Tool Transfer", tactics: ["lateral-movement"] },
  { id: "T1071", name: "Application Layer Protocol", tactics: ["command-and-control"] },
  { id: "T1571", name: "Non-Standard Port", tactics: ["command-and-control"] },
  { id: "T1105", name: "Ingress Tool Transfer", tactics: ["command-and-control"] },
  { id: "T1567", name: "Exfiltration Over Web Service", tactics: ["exfiltration"] },
  { id: "T1531", name: "Account Access Removal", tactics: ["impact"] },
  { id: "T1489", name: "Service Stop", tactics: ["impact"] },
];

const TECHNIQUE_BY_ID = new Map(ATTACK_TECHNIQUES.map((technique) => [technique.id, technique]));

/** The technique a reference names, or `null` when the catalog does not carry it. */
export function techniqueById(id: string): AttackTechnique | null {
  return TECHNIQUE_BY_ID.get(id.trim().toUpperCase()) ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Parsing references                                                        */
/* -------------------------------------------------------------------------- */

/** A reference split into the framework it belongs to and the code inside it. */
export interface ParsedReference {
  /** Upper-cased: `MITRE`, `CIS`, `SOC2`, `NIST`, `PCI`, `HIPAA`, `ISO27001`, `GDPR`. */
  framework: string;
  code: string;
  /** The reference exactly as the rule wrote it, so a report can quote it back. */
  raw: string;
}

/** `FRAMEWORK:CODE`, with the code allowed to contain dots and dashes (`T1021.002`, `A.9.4.2`). */
const REFERENCE_PATTERN = /^([A-Za-z][A-Za-z0-9]{1,15}):(.+)$/;

/**
 * Split a rule's references into framework/code pairs.
 *
 * An entry with no `FRAMEWORK:` prefix is returned in `unparsed` rather than guessed at:
 * deciding that a bare `4.1` means CIS would be this module inventing a citation, and a
 * report that cites a control the rule never named is worse than one that says it could
 * not read the line.
 */
export function parseReferences(references: readonly string[]): {
  parsed: ParsedReference[];
  unparsed: string[];
} {
  const parsed: ParsedReference[] = [];
  const unparsed: string[] = [];

  for (const raw of references) {
    const text = String(raw).trim();
    const match = REFERENCE_PATTERN.exec(text);
    if (!match) {
      unparsed.push(text);
      continue;
    }
    parsed.push({ framework: match[1].toUpperCase(), code: match[2].trim(), raw: text });
  }

  return { parsed, unparsed };
}

/** The ATT&CK technique ids a reference list names, in the order they were written. */
export function attackReferences(references: readonly string[]): string[] {
  return parseReferences(references)
    .parsed.filter((reference) => reference.framework === "MITRE")
    .map((reference) => reference.code.toUpperCase());
}

/* -------------------------------------------------------------------------- */
/*  Coverage                                                                  */
/* -------------------------------------------------------------------------- */

/** One technique as the map reports it: who names it, and what it belongs to. */
export interface TechniqueCoverage {
  id: string;
  /** `null` when the reference names a technique the catalog does not carry. */
  name: string | null;
  /** Empty for an uncatalogued technique, since no tactic can be derived. */
  tactics: AttackTactic[];
  /** Ids of the rules that name this technique. */
  rules: string[];
}

export interface TacticCoverage {
  tactic: AttackTactic;
  title: string;
  /** Rules that answer this tactic, through any technique filed under it. */
  rules: string[];
  techniques: string[];
  covered: boolean;
}

/** A tactic this rulebook does not touch. */
export interface AttackGap {
  tactic: AttackTactic;
  title: string;
  detail: string;
}

export interface AttackReport {
  techniques: TechniqueCoverage[];
  tactics: TacticCoverage[];
  /** Tactics no rule answers, in kill-chain order. The reason the report exists. */
  gaps: AttackGap[];
  /** References the catalog does not carry — a typo or a technique this build has not learned. */
  uncatalogued: { id: string; rules: string[] }[];
  /** References with no `FRAMEWORK:` prefix, which nothing can be derived from. */
  unparsedReferences: { ruleId: string; reference: string }[];
  /** Rule ids that name no ATT&CK technique at all. */
  unmappedRules: string[];
  /**
   * Whether `ATTACK_TECHNIQUES` is the whole matrix.
   *
   * `false`, and said out loud so nobody reads the tactics below as a statement about ATT&CK
   * rather than a statement about this build's catalog of it.
   */
  catalogComplete: false;
}

/**
 * Roll a rulebook up by tactic.
 *
 * Total and pure: the rules in, the map out. A rule with no ATT&CK reference lands in
 * `unmappedRules` rather than being treated as covering everything, and an uncatalogued
 * technique is listed by name rather than dropped — the two failure modes of a mapping
 * report are claiming coverage that is not there and hiding a mapping that is broken.
 */
export function attackReport(rulebook: readonly DetectionRule[]): AttackReport {
  const byTechnique = new Map<string, string[]>();
  const uncatalogued = new Map<string, string[]>();
  const unparsedReferences: AttackReport["unparsedReferences"] = [];
  const unmappedRules: string[] = [];

  for (const rule of rulebook) {
    const { parsed, unparsed } = parseReferences(rule.references);
    for (const entry of unparsed) unparsedReferences.push({ ruleId: rule.id, reference: entry });

    const techniques = parsed
      .filter((reference) => reference.framework === "MITRE")
      .map((reference) => reference.code.toUpperCase());

    if (techniques.length === 0) unmappedRules.push(rule.id);

    for (const technique of techniques) {
      if (techniqueById(technique)) {
        byTechnique.set(technique, [...(byTechnique.get(technique) ?? []), rule.id]);
      } else {
        uncatalogued.set(technique, [...(uncatalogued.get(technique) ?? []), rule.id]);
      }
    }
  }

  const techniques: TechniqueCoverage[] = [...byTechnique.entries()]
    .map(([id, rules]) => {
      const known = techniqueById(id);
      return {
        id,
        name: known?.name ?? null,
        tactics: known ? [...known.tactics] : [],
        // Sorted, like every other list on this report: the rulebook's order is not meaningful,
        // so a reordering must not move the map — a report that changed when nothing changed is
        // a report somebody learns to ignore.
        rules: [...rules].sort(),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const tactics: TacticCoverage[] = ATTACK_TACTICS.map((tactic) => {
    const answering = techniques.filter((technique) => technique.tactics.includes(tactic));
    return {
      tactic,
      title: tacticTitle(tactic),
      rules: [...new Set(answering.flatMap((technique) => technique.rules))].sort(),
      techniques: answering.map((technique) => technique.id).sort(),
      covered: answering.length > 0,
    };
  });

  const gaps: AttackGap[] = tactics
    .filter((entry) => !entry.covered)
    .map((entry) => ({
      tactic: entry.tactic,
      title: entry.title,
      detail:
        `No rule in this rulebook answers ${entry.title}. An intrusion that reaches this stage ` +
        `produces telemetry the platform stores and raises nothing about.`,
    }));

  return {
    techniques,
    tactics,
    gaps,
    uncatalogued: [...uncatalogued.entries()]
      .map(([id, rules]) => ({ id, rules }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    unparsedReferences,
    unmappedRules: [...unmappedRules].sort(),
    catalogComplete: false,
  };
}
