/**
 * Compliance control mapping (S3/S4): which framework controls the rulebook answers.
 *
 * The compliance *page* (`compliance` in the console service) reports the controls this
 * deployment is *configured* to hold — MFA required, sessions bounded, the evidence chain
 * intact. This module is the other half of the same question and the one a reviewer asks
 * second: **which of a framework's controls does detection actually produce evidence
 * for?** A rule that fires is evidence; a rule that does not exist is a control with
 * nothing behind it.
 *
 * Three decisions worth stating out loud, and each is the reason the module is small:
 *
 *  - **It reads the rules' own `references`.** Nothing here restates a mapping that lives
 *    in the rulebook, so a rule cannot reference `CIS:4.1` and be reported as covering
 *    something else. Add a reference to a rule and this report moves.
 *  - **A framework cites controls; this build carries a subset of them.** `CONTROL_CATALOG`
 *    is the controls this product genuinely maps onto, and every report says
 *    `catalogComplete: false` beside the framework name so nobody reads "5 of 5 covered"
 *    as a statement about PCI DSS rather than about this catalog of it. The honest version
 *    of a compliance claim is the one that names its denominator.
 *  - **An uncovered control is reported as uncovered.** A control in the catalog that no
 *    rule references is a gap, listed with what it would take to answer it. That is the
 *    whole value: a compliance map that only lists what is covered is a map of nothing.
 */

import type { DetectionRule } from "./detection-rules";
import { parseReferences } from "./attack-rules";

/* -------------------------------------------------------------------------- */
/*  The catalog                                                               */
/* -------------------------------------------------------------------------- */

export interface FrameworkControl {
  code: string;
  title: string;
  /** What answering this control from detection telemetry would look like. */
  expectation: string;
}

export interface Framework {
  id: string;
  name: string;
  controls: readonly FrameworkControl[];
}

/**
 * The controls this product maps onto, per framework.
 *
 * Curated rather than scraped: each entry is a control a *detection rule* can evidence,
 * which is a much smaller set than the framework itself. A framework absent from this list
 * is still parseable — a deployment can reference `MYFRAMEWORK:1.2` on a rule and the
 * coverage report will carry it — it simply has no catalog, so it reports what the rules
 * cite and claims nothing about what they do not.
 */
export const FRAMEWORKS: readonly Framework[] = [
  {
    id: "CIS",
    name: "CIS Critical Security Controls",
    controls: [
      {
        code: "4.1",
        title: "Establish and maintain a secure configuration process",
        expectation: "Detect the insecure-services class of exposure: plaintext management protocols and default ports.",
      },
      {
        code: "4.2",
        title: "Establish and maintain a secure configuration process for network infrastructure",
        expectation: "Detect remote-administration services reachable from outside the network.",
      },
      {
        code: "9.3",
        title: "Restrict and control the use of administrative ports and services",
        expectation: "Detect remote desktop and alternate management ports opened to the perimeter.",
      },
      {
        code: "12.1",
        title: "Ensure network infrastructure is up to date",
        expectation: "Detect exploitation attempts against unpatched public-facing services.",
      },
      {
        code: "13.1",
        title: "Centralize security event alerting",
        expectation: "The pipeline itself: normalized alerts, one queue, one evidence chain.",
      },
      {
        code: "13.11",
        title: "Tune security event alerts",
        expectation: "Suppression windows and false-positive verdicts, recorded with a reason.",
      },
      {
        code: "14.1",
        title: "Establish and maintain a security awareness program",
        expectation: "Out of scope for detection: a training control, owned by the training product.",
      },
    ],
  },
  {
    id: "NIST",
    name: "NIST SP 800-53 Rev. 5",
    controls: [
      { code: "AC-7", title: "Unsuccessful Logon Attempts", expectation: "Detect repeated authentication failures and sprays." },
      { code: "AC-17", title: "Remote Access", expectation: "Detect remote-access services exposed beyond the perimeter." },
      { code: "AU-6", title: "Audit Record Review, Analysis, and Reporting", expectation: "The alert queue and the hash-chained evidence log." },
      { code: "CM-7", title: "Least Functionality", expectation: "Detect unnecessary or legacy services reachable on the network." },
      { code: "IA-5", title: "Authenticator Management", expectation: "Detect credential theft from a host (credential dumping)." },
      { code: "RA-5", title: "Vulnerability Monitoring and Scanning", expectation: "Detect active scanning and service discovery against the estate." },
      { code: "SI-4", title: "System Monitoring", expectation: "Behavioural thresholds and statistical anomaly rules over telemetry." },
      { code: "SC-7", title: "Boundary Protection", expectation: "Detect inbound connections to management services across the boundary." },
    ],
  },
  {
    id: "SOC2",
    name: "AICPA SOC 2 Trust Services Criteria",
    controls: [
      { code: "CC6.1", title: "Logical access security", expectation: "Detect authentication abuse and privileged-account misuse." },
      { code: "CC6.6", title: "Boundary protection against external threats", expectation: "Detect exposed remote-access services and exploit attempts." },
      { code: "CC6.8", title: "Prevention and detection of malicious software", expectation: "Detect credential-dumping tools and web-server-spawned shells." },
      { code: "CC7.2", title: "Monitoring for anomalies", expectation: "Behavioural thresholds and anomaly rules, with the baseline derived." },
      { code: "CC7.3", title: "Evaluation of security events", expectation: "Triage: acknowledgement, assignment, verdicts and promotion." },
      { code: "CC7.4", title: "Incident response", expectation: "Prevention: the reversible, approved enforcement register." },
    ],
  },
  {
    id: "PCI",
    name: "PCI DSS v4.0",
    controls: [
      { code: "1.4", title: "Network connections between trusted and untrusted networks are controlled", expectation: "Detect inbound management-service connections from outside." },
      { code: "8.3", title: "Strong authentication for users and administrators", expectation: "Detect brute force and credential stuffing against authentication." },
      { code: "10.4", title: "Audit logs are reviewed", expectation: "The alert queue with triage states, plus the evidence chain." },
      { code: "10.6", title: "Time-synchronized and secured log mechanisms", expectation: "Normalized ISO-8601 timestamps and a hash-chained log." },
      { code: "11.4", title: "External and internal penetration testing", expectation: "Detect the scanning and lateral-movement half of a pentest." },
    ],
  },
  {
    id: "HIPAA",
    name: "HIPAA Security Rule (45 CFR §164)",
    controls: [
      { code: "164.308(a)(1)(ii)(D)", title: "Information system activity review", expectation: "The alert queue and the tamper-evident record behind it." },
      { code: "164.308(a)(5)(ii)(C)", title: "Log-in monitoring", expectation: "Detect repeated authentication failures and sprays." },
      { code: "164.312(a)(1)", title: "Access control", expectation: "Detect privileged-identity activity and account manipulation." },
      { code: "164.312(c)(1)", title: "Integrity", expectation: "The hash-chained evidence log and its verification." },
      { code: "164.312(b)", title: "Audit controls", expectation: "Detection alerts, triage decisions and enforcement all on one chain." },
    ],
  },
  {
    id: "ISO27001",
    name: "ISO/IEC 27001:2022 Annex A",
    controls: [
      { code: "A.8.7", title: "Protection against malware", expectation: "Detect credential-dumping tools and dropped web shells." },
      { code: "A.8.16", title: "Monitoring activities", expectation: "Behavioural and statistical detection, plus the coverage map." },
      { code: "A.8.20", title: "Networks security", expectation: "Detect lateral movement and management-service exposure." },
      { code: "A.5.15", title: "Access control", expectation: "Detect authentication abuse against privileged and standard accounts." },
      { code: "A.5.26", title: "Response to information security incidents", expectation: "Enforcement: the approved, reversible action register." },
    ],
  },
  {
    id: "GDPR",
    name: "EU GDPR (Regulation 2016/679)",
    controls: [
      { code: "32", title: "Security of processing", expectation: "Detection and prevention, and the audit trail that evidences both." },
      { code: "33", title: "Notification of a personal data breach", expectation: "Incident promotion with the alert's own evidence attached." },
      { code: "5", title: "Principles relating to processing", expectation: "Short alert retention and a store that keeps summaries, not a log lake." },
    ],
  },
];

const FRAMEWORK_BY_ID = new Map(FRAMEWORKS.map((framework) => [framework.id, framework]));

export function frameworkById(id: string): Framework | null {
  return FRAMEWORK_BY_ID.get(id.trim().toUpperCase()) ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Coverage                                                                  */
/* -------------------------------------------------------------------------- */

export interface ControlCoverage {
  code: string;
  title: string;
  /** Rules that cite this control. Empty is the gap. */
  rules: string[];
  covered: boolean;
  /** What answering it from detection would take. Carried so a gap is actionable. */
  expectation: string;
}

export interface FrameworkCoverage {
  id: string;
  name: string;
  /** The framework's own citation for a control it names but this build does not cover. */
  controls: ControlCoverage[];
  /** Controls with at least one rule behind them. */
  coveredCount: number;
  /** Rules that cite a control in this framework. */
  ruleCount: number;
  /** Whether the catalog is the whole framework. Always `false`; see `FRAMEWORKS`. */
  catalogComplete: false;
}

/** A control citation that no catalog carries, or a reference nothing can be read from. */
export interface ComplianceNote {
  framework: string;
  code: string;
  rules: string[];
  detail: string;
}

export interface ComplianceReport {
  frameworks: FrameworkCoverage[];
  /** Cited controls no catalog knows: a typo, or a framework this build does not map. */
  uncatalogued: ComplianceNote[];
  /** Rule ids whose references name no control in any framework. */
  unmappedRules: string[];
  /** References with no `FRAMEWORK:` prefix, which nothing can be derived from. */
  unparsedReferences: { ruleId: string; reference: string }[];
}

/**
 * Roll a rulebook up by framework control.
 *
 * Frameworks appear in catalog order, and the rules that cite nothing land in
 * `unmappedRules` — a rule with no control reference is not evidence for a control, and
 * counting it towards one is exactly the arithmetic a compliance report must not do.
 */
export function complianceReport(rulebook: readonly DetectionRule[]): ComplianceReport {
  // framework → code → rule ids, gathered from the rules themselves.
  const cited = new Map<string, Map<string, string[]>>();
  const uncatalogued = new Map<string, ComplianceNote>();
  const unmappedRules: string[] = [];
  const unparsedReferences: ComplianceReport["unparsedReferences"] = [];

  for (const rule of rulebook) {
    const { parsed, unparsed } = parseReferences(rule.references);
    for (const entry of unparsed) unparsedReferences.push({ ruleId: rule.id, reference: entry });

    const controlReferences = parsed.filter((reference) => reference.framework !== "MITRE");
    if (controlReferences.length === 0) unmappedRules.push(rule.id);

    for (const reference of controlReferences) {
      const framework = frameworkById(reference.framework);
      const known = framework?.controls.some((control) => control.code.toUpperCase() === reference.code.toUpperCase());

      if (!framework || !known) {
        const key = `${reference.framework}:${reference.code}`;
        const existing = uncatalogued.get(key);
        uncatalogued.set(key, {
          framework: reference.framework,
          code: reference.code,
          rules: [...(existing?.rules ?? []), rule.id],
          detail: framework
            ? `${reference.framework} names no control "${reference.code}" in the catalog this build carries.`
            : `This build carries no catalog for ${reference.framework}; the citation is reported, not interpreted.`,
        });
        continue;
      }

      const codes = cited.get(reference.framework) ?? new Map<string, string[]>();
      const canonical = framework.controls.find((control) => control.code.toUpperCase() === reference.code.toUpperCase())!.code;
      codes.set(canonical, [...(codes.get(canonical) ?? []), rule.id]);
      cited.set(reference.framework, codes);
    }
  }

  const frameworks: FrameworkCoverage[] = FRAMEWORKS.map((framework) => {
    const codes = cited.get(framework.id) ?? new Map<string, string[]>();
    const controls: ControlCoverage[] = framework.controls.map((control) => {
      const rules = codes.get(control.code) ?? [];
      return {
        code: control.code,
        title: control.title,
        rules,
        covered: rules.length > 0,
        expectation: control.expectation,
      };
    });

    const ruleCount = new Set(controls.flatMap((control) => control.rules)).size;
    return {
      id: framework.id,
      name: framework.name,
      controls,
      coveredCount: controls.filter((control) => control.covered).length,
      ruleCount,
      catalogComplete: false,
    };
  });

  return {
    frameworks,
    uncatalogued: [...uncatalogued.values()].sort((a, b) =>
      `${a.framework}:${a.code}`.localeCompare(`${b.framework}:${b.code}`),
    ),
    unmappedRules: [...new Set(unmappedRules)].sort(),
    unparsedReferences,
  };
}
