/**
 * Detection coverage rules (S3): what the rulebook actually watches, as data.
 *
 * Detection has two halves that are easy to confuse and that a deployment has to be able
 * to tell apart: what the platform *declares* it can ingest, and what a rule actually
 * *reads*. A source list with no rule behind it is not coverage — it is a promise that
 * events will be stored and raise nothing — and, in this product's case, the sources were
 * declared vocabulary before any of them had a reader. This module is the honest map
 * between the two: for every kind and every source, the rules that would look at it, and
 * the ones that are watched by nothing.
 *
 * Four decisions worth stating out loud:
 *
 *  - **It is derived from the rulebook, not restated.** The rules are the input, so the
 *    map cannot claim a rule reads something the rule does not, or miss one that does.
 *    Add a rule to `DETECTION_RULES` and it appears here with no second edit.
 *  - **A rule's `appliesTo` is applied the way the pipeline applies it.** `kinds` and
 *    `sources` are both optional and mean different things: a rule with neither reads
 *    everything, and a rule that names sources overrides the kind reading. This module
 *    uses exactly the same `defaultKindForSource` the normalizer uses, so \"which kind is a
 *    NetFlow record\" has one answer rather than two.
 *  - **An absence is reported as an absence.** A source no rule reads is on the map as a
 *    blind spot, never dropped from it — the page a reviewer reads has to show the gaps,
 *    because a coverage map that only lists what is covered is a map that hides the reason
 *    somebody asked for it.
 *  - **\"Watched\" is a statement about rules, not about collectors.** Every source here is
 *    declared vocabulary: the ingest surface accepts a batch a collector posts, and no
 *    source has a streaming listener yet. A source being \"watched\" therefore means a rule
 *    would read an event from it, not that one is arriving — and the page says so.
 */

import { DETECTION_RULES, type DetectionRule } from "./detection-rules";
import {
  TELEMETRY_KINDS,
  TELEMETRY_SOURCES,
  defaultKindForSource,
  type TelemetryKind,
  type TelemetrySource,
} from "./telemetry-rules";

/** The three shapes a rule can take, as the map names them. */
export type CoverageShape = "signature" | "behavioural" | "sequence";

export interface CoverageRuleView {
  id: string;
  version: number;
  name: string;
  severity: string;
  shape: CoverageShape;
  references: string[];
  /** The kinds the rule reads. Empty means every kind. */
  kinds: string[];
  /** The sources the rule names. Empty means the kinds decide which sources it reads. */
  sources: string[];
}

export interface KindCoverage {
  kind: TelemetryKind;
  /** Ids of the rules that read this kind. Empty is the blind spot. */
  rules: string[];
  covered: boolean;
}

export interface SourceCoverage {
  source: TelemetrySource;
  /** The kind an event from this source is filed under when it states none. */
  kind: TelemetryKind;
  rules: string[];
  covered: boolean;
}

/** A blind spot: something this build declares and no rule reads. */
export interface CoverageGap {
  what: "kind" | "source";
  name: string;
  detail: string;
}

export interface CoverageReport {
  rules: CoverageRuleView[];
  kinds: KindCoverage[];
  sources: SourceCoverage[];
  /** Every kind and source no rule reads, kinds first. The reason the page exists. */
  gaps: CoverageGap[];
  /** Rules that read nothing this build declares — usually a typo in `appliesTo`. */
  unreachable: { id: string; detail: string }[];
}

/**
 * Whether a rule reads a given kind.
 *
 * A rule with no `kinds` reads every kind, which is the pipeline's own reading: it is
 * `ruleApplies` that decides, and this repeats its rule rather than inventing one.
 */
export function ruleReadsKind(rule: DetectionRule, kind: string): boolean {
  const kinds = rule.appliesTo.kinds;
  return !kinds || kinds.includes(kind);
}

/**
 * Whether a rule reads a given source.
 *
 * An explicit `sources` list wins; otherwise the source's own kind decides, which is what
 * the pipeline does when it normalizes the payload and hands the rule an event.
 */
export function ruleReadsSource(rule: DetectionRule, source: TelemetrySource): boolean {
  const sources = rule.appliesTo.sources;
  if (sources) return sources.includes(source);
  return ruleReadsKind(rule, defaultKindForSource(source));
}

/** The shape a rule takes, from its own `detection.kind` rather than a second field. */
export function shapeOf(rule: DetectionRule): CoverageShape {
  return rule.detection.kind;
}

/**
 * Build the map from a rulebook.
 *
 * Defaults to the rules this build ships, and takes a rulebook so a test can hand it a
 * deliberately narrow one and assert the gaps it names.
 */
export function coverageReport(rulebook: readonly DetectionRule[] = DETECTION_RULES): CoverageReport {
  const rules: CoverageRuleView[] = rulebook.map((rule) => ({
    id: rule.id,
    version: rule.version,
    name: rule.name,
    severity: rule.severity,
    shape: shapeOf(rule),
    references: [...rule.references],
    kinds: rule.appliesTo.kinds ? [...rule.appliesTo.kinds] : [],
    sources: rule.appliesTo.sources ? [...rule.appliesTo.sources] : [],
  }));

  const kinds: KindCoverage[] = TELEMETRY_KINDS.map((kind) => {
    const readers = rulebook.filter((rule) => ruleReadsKind(rule, kind)).map((rule) => rule.id);
    return { kind, rules: readers, covered: readers.length > 0 };
  });

  const sources: SourceCoverage[] = TELEMETRY_SOURCES.map((source) => {
    const readers = rulebook.filter((rule) => ruleReadsSource(rule, source)).map((rule) => rule.id);
    return { source, kind: defaultKindForSource(source), rules: readers, covered: readers.length > 0 };
  });

  const gaps: CoverageGap[] = [
    ...kinds
      .filter((entry) => !entry.covered)
      .map<CoverageGap>((entry) => ({
        what: "kind",
        name: entry.kind,
        detail:
          `No rule reads ${entry.kind} telemetry. Events of this kind reach the store and raise ` +
          `nothing until a rule is written for them.`,
      })),
    ...sources
      .filter((entry) => !entry.covered)
      .map<CoverageGap>((entry) => ({
        what: "source",
        name: entry.source,
        detail:
          `No rule reads ${entry.source}, whose events are filed as ${entry.kind}. A collector may ` +
          `still post them; nothing looks.`,
      })),
  ];

  // A rule whose `appliesTo` names a kind or source this build does not have would read no
  // event at all, and would otherwise look like coverage on the map because its id is on
  // the rulebook. Naming it is cheaper than letting a typo look like detection.
  const declaredKinds = new Set<string>(TELEMETRY_KINDS);
  const declaredSources = new Set<string>(TELEMETRY_SOURCES);
  // One entry per rule, not one per stray list: an operator reads a rule's name once and is
  // told everything wrong with it, rather than meeting the same id on two lines.
  const unreachable = rulebook.flatMap((rule) => {
    const problems: string[] = [];
    const strayKinds = (rule.appliesTo.kinds ?? []).filter((kind) => !declaredKinds.has(kind));
    const straySources = (rule.appliesTo.sources ?? []).filter((source) => !declaredSources.has(source));
    if (strayKinds.length > 0) problems.push(`kind(s) this build has no vocabulary for: ${strayKinds.join(", ")}`);
    if (straySources.length > 0) problems.push(`source(s) this build has no vocabulary for: ${straySources.join(", ")}`);
    return problems.length > 0 ? [{ id: rule.id, detail: `names ${problems.join("; ")}` }] : [];
  });

  return { rules, kinds, sources, gaps, unreachable };
}
