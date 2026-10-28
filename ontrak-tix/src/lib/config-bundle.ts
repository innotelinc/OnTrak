/**
 * Config as code (2.4): a desk's queues, SLA calendars, custom fields and macros
 * as one file that can be reviewed, diffed and promoted between environments.
 *
 * The file is the unit of review. An operator compares two environments by
 * comparing two bundles, and applies one with a diff in front of them — which
 * only works if the *same configuration* always serialises to the *same bytes*.
 * Everything here is in service of that:
 *
 *  - **Natural keys, never row ids.** A bundle names a queue by its slug, an SLA
 *    policy by its name, a field by its key and a macro by its name. Ids and
 *    timestamps are exactly what differ between staging and production, so
 *    carrying them would make every promotion a full-file rewrite and every diff
 *    noise. Names are also what a person reads in the review.
 *  - **Canonical output.** Sections are sorted by those keys, fields appear in a
 *    fixed order, strings are trimmed, holidays are normalised through the same
 *    rules that wrote them, and the JSON is indented with a trailing newline. So
 *    `serialize(build(state)) === serialize(build(apply(state, bundle)))`, byte
 *    for byte — which is the milestone's exit, and is tested as bytes rather
 *    than as deep equality.
 *  - **Refuse all at once, and name the row.** A bundle with three mistakes gets
 *    three sentences, each pointing at `macros.2.actions.0`, because the person
 *    fixing it is reading a terminal at 02:00 and a first-error-only loop makes
 *    them run the command four times.
 *  - **Import upserts; it never deletes.** A bundle says what a desk *should*
 *    have. Removing something is a decision with its own consequences (a queue
 *    with open tickets, a field holding answers), so an import that quietly
 *    deleted it would be a data-loss bug wearing a config hat. Anything present
 *    in the environment but absent from the bundle is left exactly as it is, and
 *    the diff counts it as untouched by reporting only what the bundle names.
 *
 * Pure: no Prisma, no framework, no clock, no filesystem. `config-code.ts`
 * loads the rows and writes them; this module decides what the file means.
 */

import { normalizeHolidays } from "./holiday-rules";
import { validateField, type FieldType } from "./form-rules";
import { validateMacro } from "./macro-rules";
import { TICKET_PRIORITIES, type RuleAction } from "./rule-rules";
import {
  validateSlaPolicy,
  type BusinessCalendar,
  type BusinessWindow,
  type HolidayDate,
} from "./sla-rules";

/* -------------------------------------------------------------------------- */
/*  The records                                                              */
/* -------------------------------------------------------------------------- */

export const CONFIG_FORMAT = "ontrak.tix.config/v1";

/** The shape every slug in a bundle has: the tenant's and each queue's. */
export const CONFIG_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const QUEUE_NAME_MAX = 120;

export interface QueueConfig {
  slug: string;
  name: string;
}

/**
 * One SLA policy, with its calendar inline.
 *
 * `queue` is the queue's *slug* and `priority` is a ticket priority or `null`
 * for "any"; both are optional on the row, and `null` is how "not scoped" is
 * written so the file never needs an absent key to mean something.
 *
 * A policy scoped to a *client* is deliberately not part of this shape: a client
 * is business data (a contract, a set of people), not configuration, and a
 * promotion into an environment that has never heard of them would either fail
 * or, worse, attach a promise to whoever happens to hold that id.
 */
export interface SlaPolicyConfig {
  name: string;
  queue: string | null;
  priority: string | null;
  responseMinutes: number;
  resolutionMinutes: number;
  warningFraction: number;
  calendar: BusinessCalendar;
}

export interface CustomFieldConfig {
  key: string;
  label: string;
  type: FieldType;
  options: string[];
  requiredByDefault: boolean;
  placeholder: string;
  helpText: string;
  /** Retired fields are carried: the bundle is the desk's whole field list. */
  archived: boolean;
}

export interface MacroConfig {
  name: string;
  description: string;
  actions: RuleAction[];
  enabled: boolean;
}

/** A desk's promotable configuration, without the format marker. */
export interface ConfigState {
  tenant: string;
  queues: QueueConfig[];
  slaPolicies: SlaPolicyConfig[];
  customFields: CustomFieldConfig[];
  macros: MacroConfig[];
}

export interface ConfigBundle extends ConfigState {
  format: typeof CONFIG_FORMAT;
}

export interface ConfigIssue {
  field: string;
  message: string;
}

/* -------------------------------------------------------------------------- */
/*  Canonical form                                                           */
/* -------------------------------------------------------------------------- */

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list<T>(value: readonly T[] | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * A calendar as the file carries it.
 *
 * `holidays` is always present, even when empty, and normalised (sorted,
 * de-duplicated, real dates only) through the rules that accept a hand-typed
 * closure — so a row edited in the database and a file exported from it are the
 * same bytes. The weekly windows keep their order: they are an author's list,
 * and re-sorting them would be a change nobody asked for.
 */
function canonicalCalendar(value: BusinessCalendar | undefined): BusinessCalendar {
  const week: BusinessWindow[][] = [];
  const source = Array.isArray(value?.week) ? value.week : [];
  for (let day = 0; day < 7; day += 1) {
    const windows: readonly BusinessWindow[] = Array.isArray(source[day]) ? source[day] : [];
    week.push(windows.map((window) => ({ startMinute: window.startMinute, endMinute: window.endMinute })));
  }
  return {
    name: typeof value?.name === "string" ? value.name : "",
    utcOffsetMinutes: typeof value?.utcOffsetMinutes === "number" ? value.utcOffsetMinutes : 0,
    week,
    holidays: normalizeHolidays(value?.holidays as readonly HolidayDate[] | undefined).dates,
  };
}

function canonicalQueue(queue: QueueConfig): QueueConfig {
  return { slug: text(queue.slug), name: text(queue.name) };
}

function canonicalPolicy(policy: SlaPolicyConfig): SlaPolicyConfig {
  return {
    name: text(policy.name),
    queue: typeof policy.queue === "string" && policy.queue.trim() !== "" ? policy.queue.trim() : null,
    priority: typeof policy.priority === "string" && policy.priority.trim() !== "" ? policy.priority.trim() : null,
    responseMinutes: policy.responseMinutes,
    resolutionMinutes: policy.resolutionMinutes,
    warningFraction: policy.warningFraction,
    calendar: canonicalCalendar(policy.calendar),
  };
}

function canonicalField(field: CustomFieldConfig): CustomFieldConfig {
  return {
    key: text(field.key),
    label: text(field.label),
    type: text(field.type).toUpperCase() as FieldType,
    options: list(field.options).map((option) => text(option)),
    requiredByDefault: Boolean(field.requiredByDefault),
    placeholder: text(field.placeholder),
    helpText: text(field.helpText),
    archived: Boolean(field.archived),
  };
}

function canonicalMacro(macro: MacroConfig): MacroConfig {
  return {
    name: text(macro.name),
    description: text(macro.description),
    actions: list(macro.actions).map((action) => ({ kind: action.kind, value: action.value })),
    enabled: Boolean(macro.enabled),
  };
}

/**
 * Everything in its one canonical form: trimmed, sorted, structurally complete.
 *
 * Written explicitly rather than as a spread so a column added to a table cannot
 * silently appear in a promoted file — a field nobody decided to promote must
 * not be promoted by a `...row`.
 */
function canonicalState(state: ConfigState): ConfigState {
  return {
    tenant: text(state.tenant),
    queues: list(state.queues).map(canonicalQueue).sort((a, b) => byKey(a.slug, b.slug)),
    slaPolicies: list(state.slaPolicies).map(canonicalPolicy).sort((a, b) => byKey(a.name, b.name)),
    customFields: list(state.customFields).map(canonicalField).sort((a, b) => byKey(a.key, b.key)),
    macros: list(state.macros).map(canonicalMacro).sort((a, b) => byKey(a.name, b.name)),
  };
}

/** A state as the bundle that represents it. */
export function buildBundle(state: ConfigState): ConfigBundle {
  return { format: CONFIG_FORMAT, ...canonicalState(state) };
}

/**
 * The bytes of a bundle.
 *
 * This is the function the promotion promise is about: the same configuration
 * has one serialisation, so `git diff` between two exported files shows the
 * configuration change and nothing else. Two spaces and a trailing newline,
 * because the file is meant to be read and committed.
 */
export function serializeBundle(bundle: ConfigBundle): string {
  return `${JSON.stringify(buildBundle(bundle), null, 2)}\n`;
}

/* -------------------------------------------------------------------------- */
/*  Reading a file                                                           */
/* -------------------------------------------------------------------------- */

export type BundleRead = { ok: true; bundle: ConfigBundle } | { ok: false; issues: ConfigIssue[] };

const KNOWN_KEYS = new Set(["format", "tenant", "queues", "slaPolicies", "customFields", "macros"]);

/**
 * What is wrong with a calendar's weekly shape, if anything.
 *
 * Checked before the calendar reaches `validateSlaPolicy`, because a hand-edited
 * file can put a number or a null where a window belongs and the SLA validator
 * reads `window.startMinute` directly. A refusal names the calendar; it must not
 * be a stack trace.
 */
function calendarShapeIssue(calendar: BusinessCalendar): string | null {
  if (!Array.isArray(calendar.week) || calendar.week.length !== 7) {
    return "The calendar needs seven weekdays, Sunday first.";
  }
  for (const day of calendar.week) {
    if (!Array.isArray(day)) return "Each weekday is a list of open windows.";
    for (const window of day) {
      if (!isRecord(window) || typeof window.startMinute !== "number" || typeof window.endMinute !== "number") {
        return "Each open window carries a start and an end in minutes from midnight.";
      }
    }
  }
  return null;
}

function arrayAt(raw: Record<string, unknown>, field: string, issues: ConfigIssue[]): unknown[] {
  const value = raw[field];
  if (!Array.isArray(value)) {
    issues.push({ field, message: `“${field}” is missing or is not a list — a bundle names every section, even when it is empty.` });
    return [];
  }
  return value;
}

/**
 * Read a file into a bundle, or say everything wrong with it.
 *
 * The order matters: an unknown format version ends the read immediately,
 * because every later sentence would be a guess about a shape this build does
 * not know. Within the known version, every section is read and every problem
 * collected — including a section that is absent, because a truncated file must
 * not import as "this desk has no macros".
 */
export function readBundle(raw: unknown): BundleRead {
  if (!isRecord(raw)) {
    return { ok: false, issues: [{ field: "bundle", message: "A configuration bundle is a JSON object." }] };
  }

  const format = text(raw.format);
  if (format !== CONFIG_FORMAT) {
    return {
      ok: false,
      issues: [
        {
          field: "format",
          message: `This build reads ${CONFIG_FORMAT}; the file says ${format ? `“${format}”` : "nothing"}.`,
        },
      ],
    };
  }

  const issues: ConfigIssue[] = [];
  for (const key of Object.keys(raw).sort(byKey)) {
    if (!KNOWN_KEYS.has(key)) {
      issues.push({ field: key, message: `“${key}” is not part of ${CONFIG_FORMAT}, so this build cannot know what it means.` });
    }
  }

  const tenant = text(raw.tenant);
  if (!CONFIG_SLUG.test(tenant)) {
    issues.push({ field: "tenant", message: "The tenant slug is lower-case letters, digits and dashes, and starts with a letter or digit." });
  }

  /* Queues ---------------------------------------------------------------- */

  const queues: QueueConfig[] = [];
  const queueSlugs = new Set<string>();
  arrayAt(raw, "queues", issues).forEach((entry, index) => {
    const at = `queues.${index}`;
    if (!isRecord(entry)) {
      issues.push({ field: at, message: "Each queue is an object with a slug and a name." });
      return;
    }
    const slug = text(entry.slug);
    const name = text(entry.name);
    if (!CONFIG_SLUG.test(slug)) {
      issues.push({ field: `${at}.slug`, message: "A queue slug is lower-case letters, digits and dashes, and starts with a letter or digit." });
    } else if (queueSlugs.has(slug)) {
      issues.push({ field: `${at}.slug`, message: `Two queues use the slug “${slug}”; the second one cannot be the target of anything.` });
    }
    if (slug) queueSlugs.add(slug);
    if (!name) issues.push({ field: `${at}.name`, message: "A queue needs a name — it is what an agent reads." });
    else if (name.length > QUEUE_NAME_MAX) {
      issues.push({ field: `${at}.name`, message: `The name may be at most ${QUEUE_NAME_MAX} characters.` });
    }
    queues.push({ slug, name });
  });

  /* SLA policies ---------------------------------------------------------- */

  const slaPolicies: SlaPolicyConfig[] = [];
  const policyNames = new Set<string>();
  arrayAt(raw, "slaPolicies", issues).forEach((entry, index) => {
    const at = `slaPolicies.${index}`;
    if (!isRecord(entry)) {
      issues.push({ field: at, message: "Each SLA policy is an object with a name, two targets and a calendar." });
      return;
    }
    const name = text(entry.name);
    const queue = typeof entry.queue === "string" && entry.queue.trim() !== "" ? entry.queue.trim() : null;
    const priority = typeof entry.priority === "string" && entry.priority.trim() !== "" ? entry.priority.trim() : null;
    const calendar = isRecord(entry.calendar) ? (entry.calendar as unknown as BusinessCalendar) : undefined;

    if (name) {
      const folded = name.toLowerCase();
      if (policyNames.has(folded)) {
        issues.push({ field: `${at}.name`, message: `Two policies use the name “${name}”; a promotion cannot tell them apart.` });
      }
      policyNames.add(folded);
    }
    if (queue !== null && !queueSlugs.has(queue)) {
      issues.push({
        field: `${at}.queue`,
        message: `“${queue}” is not a queue in this bundle; a policy must be scoped to a queue the bundle carries, or to none.`,
      });
    }
    if (priority !== null && !TICKET_PRIORITIES.includes(priority)) {
      issues.push({ field: `${at}.priority`, message: `“${priority}” is not a priority; leave it out to mean “any”.` });
    }
    const calendarProblem = calendar
      ? calendarShapeIssue(calendar)
      : "A policy needs a calendar — the weekly windows its clock runs on.";
    if (calendarProblem) issues.push({ field: `${at}.calendar`, message: calendarProblem });
    if (calendar && !calendarProblem) {
      const refused = normalizeHolidays(calendar.holidays).refused;
      for (const refusal of refused) {
        issues.push({ field: `${at}.calendar.holidays`, message: `${refusal.value}: ${refusal.reason}.` });
      }
    }

    const wellFormed = calendar && !calendarProblem ? calendar : undefined;
    for (const issue of validateSlaPolicy({
      name,
      responseMinutes: entry.responseMinutes as number,
      resolutionMinutes: entry.resolutionMinutes as number,
      warningFraction: entry.warningFraction as number,
      calendar: wellFormed,
    })) {
      issues.push({ field: `${at}.${issue.field}`, message: issue.message });
    }

    slaPolicies.push({
      name,
      queue,
      priority,
      responseMinutes: entry.responseMinutes as number,
      resolutionMinutes: entry.resolutionMinutes as number,
      warningFraction: entry.warningFraction as number,
      calendar: canonicalCalendar(wellFormed),
    });
  });

  /* Custom fields --------------------------------------------------------- */

  const customFields: CustomFieldConfig[] = [];
  const fieldKeys = new Set<string>();
  arrayAt(raw, "customFields", issues).forEach((entry, index) => {
    const at = `customFields.${index}`;
    if (!isRecord(entry)) {
      issues.push({ field: at, message: "Each custom field is an object with a key, a label and a type." });
      return;
    }
    const key = text(entry.key);
    const label = text(entry.label);
    const type = text(entry.type).toUpperCase();
    const options = Array.isArray(entry.options) ? entry.options.map((option) => text(option)) : [];

    if (key) {
      if (fieldKeys.has(key)) {
        issues.push({ field: `${at}.key`, message: `Two fields use the key “${key}”; answers would be stored under one of them.` });
      }
      fieldKeys.add(key);
    }
    for (const issue of validateField({ key, label, type, options, placeholder: text(entry.placeholder), helpText: text(entry.helpText) })) {
      issues.push({ field: `${at}.${issue.field}`, message: issue.message });
    }
    for (const [name, value] of [
      ["requiredByDefault", entry.requiredByDefault],
      ["archived", entry.archived],
    ] as const) {
      if (value !== undefined && typeof value !== "boolean") {
        issues.push({ field: `${at}.${name}`, message: `“${name}” is true or false, written as a JSON boolean.` });
      }
    }

    customFields.push({
      key,
      label,
      type: type as FieldType,
      options,
      requiredByDefault: Boolean(entry.requiredByDefault),
      placeholder: text(entry.placeholder),
      helpText: text(entry.helpText),
      archived: Boolean(entry.archived),
    });
  });

  /* Macros ---------------------------------------------------------------- */

  const macros: MacroConfig[] = [];
  const macroNames = new Set<string>();
  arrayAt(raw, "macros", issues).forEach((entry, index) => {
    const at = `macros.${index}`;
    if (!isRecord(entry)) {
      issues.push({ field: at, message: "Each macro is an object with a name and a list of actions." });
      return;
    }
    const name = text(entry.name);
    const rawActions = Array.isArray(entry.actions) ? entry.actions : [];
    const actions: RuleAction[] = [];
    let actionsWellFormed = Array.isArray(entry.actions);
    if (!actionsWellFormed) {
      issues.push({ field: `${at}.actions`, message: "A macro's actions are a list." });
    }
    rawActions.forEach((action, actionIndex) => {
      const where = `${at}.actions.${actionIndex}`;
      if (!isRecord(action)) {
        issues.push({ field: where, message: "Each action is an object with a kind." });
        actionsWellFormed = false;
        return;
      }
      if (typeof action.kind !== "string") {
        issues.push({ field: where, message: "Each action names its kind, e.g. “set_priority” or “add_tag”." });
        actionsWellFormed = false;
      }
      if (action.value !== undefined && typeof action.value !== "string") {
        issues.push({ field: `${where}.value`, message: "An action's value is a string." });
        actionsWellFormed = false;
      }
      actions.push({ kind: action.kind as RuleAction["kind"], value: typeof action.value === "string" ? action.value : undefined });
    });

    if (name) {
      const folded = name.toLowerCase();
      if (macroNames.has(folded)) {
        issues.push({ field: `${at}.name`, message: `Two macros use the name “${name}”; an agent cannot choose between them.` });
      }
      macroNames.add(folded);
    }
    // The action validator reads each action's fields; on a malformed entry it
    // would throw rather than refuse. The shape checks above cover that, so it
    // only runs when the entries are objects with string fields.
    if (actionsWellFormed) {
      for (const issue of validateMacro({ name, description: text(entry.description), actions })) {
        issues.push({ field: `${at}.${issue.field}`, message: issue.message });
      }
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
      issues.push({ field: `${at}.enabled`, message: "“enabled” is true or false, written as a JSON boolean." });
    }

    macros.push({
      name,
      description: text(entry.description),
      actions,
      enabled: entry.enabled === undefined ? true : Boolean(entry.enabled),
    });
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, bundle: buildBundle({ tenant, queues, slaPolicies, customFields, macros }) };
}

/* -------------------------------------------------------------------------- */
/*  Diff                                                                     */
/* -------------------------------------------------------------------------- */

export type ConfigChange = "create" | "update" | "unchanged";

export interface DiffEntry {
  /** The natural key, as the file names it. */
  key: string;
  change: ConfigChange;
  /** The top-level fields that differ; empty for a create and for an unchanged row. */
  fields: string[];
}

export interface SectionDiff {
  total: number;
  create: DiffEntry[];
  update: DiffEntry[];
  unchanged: DiffEntry[];
}

export interface BundleDiff {
  /** The tenant the bundle names. */
  from: string;
  /** The tenant it would be applied to. */
  to: string;
  queues: SectionDiff;
  slaPolicies: SectionDiff;
  customFields: SectionDiff;
  macros: SectionDiff;
  /** Every entry the file changes, across all sections. */
  changes: number;
  summary: string;
}

function differingFields(before: unknown, after: unknown): string[] {
  const a: Record<string, unknown> = isRecord(before) ? before : {};
  const b: Record<string, unknown> = isRecord(after) ? after : {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(byKey);
  return keys.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

function sectionDiff<T>(current: readonly T[], incoming: readonly T[], keyOf: (row: T) => string): SectionDiff {
  const before = new Map(current.map((row) => [keyOf(row), row]));
  const entries: DiffEntry[] = incoming.map((row) => {
    const key = keyOf(row);
    const existing = before.get(key);
    if (!existing) return { key, change: "create", fields: [] };
    const fields = differingFields(existing, row);
    return { key, change: fields.length > 0 ? "update" : "unchanged", fields };
  });
  const create = entries.filter((entry) => entry.change === "create");
  const update = entries.filter((entry) => entry.change === "update");
  const unchanged = entries.filter((entry) => entry.change === "unchanged");
  return { total: entries.length, create, update, unchanged };
}

function describeSection(label: [string, string], section: SectionDiff): string {
  const noun = section.total === 1 ? label[0] : label[1];
  if (section.total === 0) return `no ${label[1]}`;
  return `${section.total} ${noun} (${section.create.length} new, ${section.update.length} changed, ${section.unchanged.length} unchanged)`;
}

/**
 * What applying `incoming` to `current` would create, change and leave alone.
 *
 * The comparison is over the canonical form, so a file that differs only in key
 * order, whitespace or a holiday list typed in a different order is correctly
 * reported as unchanged — which is what makes a promotion reviewable: every line
 * the diff prints is a real change.
 *
 * Rows present in the target but absent from the bundle are not listed at all;
 * the import leaves them untouched, and pretending they are "deleted" would be
 * a lie about what the command does.
 */
export function diffBundle(current: ConfigState, incoming: ConfigBundle): BundleDiff {
  const before = buildBundle(current);
  const after = buildBundle(incoming);
  const queues = sectionDiff(before.queues, after.queues, (row) => row.slug);
  const slaPolicies = sectionDiff(before.slaPolicies, after.slaPolicies, (row) => row.name);
  const customFields = sectionDiff(before.customFields, after.customFields, (row) => row.key);
  const macros = sectionDiff(before.macros, after.macros, (row) => row.name);
  const changes =
    queues.create.length + queues.update.length +
    slaPolicies.create.length + slaPolicies.update.length +
    customFields.create.length + customFields.update.length +
    macros.create.length + macros.update.length;

  const parts = [
    describeSection(["queue", "queues"], queues),
    describeSection(["SLA policy", "SLA policies"], slaPolicies),
    describeSection(["custom field", "custom fields"], customFields),
    describeSection(["macro", "macros"], macros),
  ];

  return {
    from: before.tenant,
    to: after.tenant,
    queues,
    slaPolicies,
    customFields,
    macros,
    changes,
    summary: `${parts.join(" · ")} — ${changes === 0 ? "nothing to change" : `${changes} change${changes === 1 ? "" : "s"}`}.`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Applying, without a database                                             */
/* -------------------------------------------------------------------------- */

function upsertBy<T>(current: readonly T[], incoming: readonly T[], keyOf: (row: T) => string): T[] {
  const rows = new Map(current.map((row) => [keyOf(row), row]));
  for (const row of incoming) rows.set(keyOf(row), row);
  return [...rows.values()];
}

/**
 * The bundle applied to a state, as data.
 *
 * This is the function the byte-identical promise is stated against: applying a
 * bundle and rebuilding it must return exactly the input bytes, because
 * otherwise a promotion is not "the staging configuration" but "the staging
 * configuration as this build chose to re-spell it". `config-code.ts` writes the
 * same upsert shape to the database, so the property tested here is the property
 * that runs.
 *
 * The target's tenant slug is kept: a bundle is applied *to* an environment, and
 * the file's own `tenant` is the source it came from (recorded in the audit
 * entry, and refused in `config-code.ts` unless the promotion is deliberate).
 */
export function applyToState(current: ConfigState, incoming: ConfigBundle): ConfigState {
  const target = canonicalState(current);
  const source = buildBundle(incoming);
  return canonicalState({
    tenant: target.tenant,
    queues: upsertBy(target.queues, source.queues, (row) => row.slug),
    slaPolicies: upsertBy(target.slaPolicies, source.slaPolicies, (row) => row.name),
    customFields: upsertBy(target.customFields, source.customFields, (row) => row.key),
    macros: upsertBy(target.macros, source.macros, (row) => row.name),
  });
}
