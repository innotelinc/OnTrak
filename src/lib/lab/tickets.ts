/**
 * The in-house ticket system: the form a student fills in and hands over.
 *
 * The TypeScript half of OnTrak-dev's `ontrak/tickets.py`. A scenario grades the
 * *machine*; a ticket grades the *technician*, and the split is deliberate: fixing a
 * fault and explaining it are different skills, and a support desk hires for the second
 * one. A fix nobody wrote down gets re-done next week, and the ticket that says
 * "restarted it, seems fine" is worse than useless.
 *
 * A scenario declares the rubric in its manifest:
 *
 *     ticket:
 *       form:
 *         title: Incident write-up
 *         weight: 30                 # share of the final grade
 *         fields:
 *           - id: root_cause
 *             label: Root cause
 *             kind: textarea
 *             weight: 30
 *             min_words: 6
 *             any_of: [permission, chmod, mode]
 *
 * and the student's answers are marked against it — required, minimum length,
 * must-mention / must-mention-one-of terms, and dropdown expectations. The submission is
 * a blend:
 *
 *     final = machine_score * (1 - ticket.weight/100)
 *           + ticket_score  * (ticket.weight/100)
 *
 * which is why `ticket.weight` is capped (the machine state is always the larger part)
 * and why a scenario without a form grades exactly as it did before: no form, no ticket
 * component, nothing to fill in.
 *
 * Grading is keyword-and-length based, not a language model, and it says so in the
 * feedback ("never mentions permission"). That is honest: a rubric that pretended to
 * understand prose would be worse than one that checks for the terms a competent answer
 * cannot avoid.
 *
 * Three decisions the port keeps exactly, because each one is load-bearing.
 *
 * **The write-up control has a reserved name.** The fields and the Save/Preview/Complete
 * buttons share one HTML form, and the fields are serialised first, so a ticket field
 * called `action` — which is what a scenario naturally calls "what you changed" — was
 * submitted in the same slot as the button control: the handler read the student's own
 * prose, matched neither `save` nor `preview`, and *Save draft* graded the machine and
 * destroyed it. `WRITEUP_ACTION` is a name a scenario cannot shadow (`RESERVED_FIELD_IDS`,
 * enforced by `validateForm`), and `action` itself stays legal for a field.
 *
 * **A draft is not a grade.** Drafts live in the store's meta table under
 * `ticket_draft:<sessionId>`; the tickets table means "a graded submission", because the
 * lab is results-only and an unsubmitted draft must not appear in a report. That split is
 * the store's to keep (`store.ts`), and this module only says what a marked submission is.
 *
 * **The score is a weighted percentage, rounded the way Python rounded it.** Weights are
 * floats (`12.25` scored as `12.2` under `round(value, 1)`), so this module asks
 * `roundHalfEven` from `scoring.ts` rather than `Math.round`: a lab host moving to this
 * stack must not see two figures for the same submission.
 *
 * One divergence, narrowing rather than widening: a *missing* answer is the empty string
 * where Python's `str(None)` produced the literal `"None"`. Both are "no answer" to every
 * rubric here, and only the stored copy of the values differs.
 *
 * Pure: no I/O, no database, no clock beyond `iso()` from `models.ts`.
 */

import { iso } from "./models";
import { formatFixed, roundHalfEven } from "./scoring";

/**
 * Field kinds the portal can render and the grader understands.
 *
 * A `readonly string[]` rather than a union, because a field's `kind` is a plain string: a
 * manifest that misspells one has to reach `validateForm` so the message can name what was
 * expected, and folding it to a union at parse time would turn a typo into a `textarea`.
 */
export const KINDS: readonly string[] = ["text", "textarea", "select", "checkbox", "number"];

/** The largest share of the final grade a write-up may carry. */
export const MAX_TICKET_WEIGHT = 60.0;
/** The share a form gets when it does not say. */
export const DEFAULT_TICKET_WEIGHT = 30.0;

/**
 * The name of the write-up form's submitting control.
 *
 * Deliberately *not* `action`, which is what most scenarios call one of their own fields.
 * See the header: a field that shadowed the button control made *Save draft* submit the
 * session. `RESERVED_FIELD_IDS` keeps a scenario from taking it.
 */
export const WRITEUP_ACTION = "ontrak_writeup";

/** Control names the portal's own forms use, which a ticket field may not take. */
export const RESERVED_FIELD_IDS: ReadonlySet<string> = new Set([WRITEUP_ACTION, "csrf"]);

/** What counts as a word. A path is one token, not three words of padding. */
const WORD_RE = /[A-Za-z0-9][A-Za-z0-9'./_-]*/g;

/** Raised when a ticket form is malformed or a submission cannot be graded. */
export class TicketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketError";
  }
}

/* -------------------------------------------------------------------------- */
/*  Fields                                                                    */
/* -------------------------------------------------------------------------- */

/** One question on the ticket, with the rubric used to mark it. */
export interface TicketField {
  id: string;
  label: string;
  /**
   * One of `KINDS`, or whatever the manifest spelled.
   *
   * Kept as a plain string rather than the union: a manifest whose `kind:` is misspelled
   * has to reach `validateForm` so the message can name what was expected, and folding it
   * to a union here would silently make it `textarea` instead.
   */
  kind: string;
  weight: number;
  required: boolean;
  minWords: number;
  maxWords: number;
  /**
   * Every term here must appear (case-insensitive) for the field to pass — use it for
   * things a correct answer cannot avoid saying.
   */
  allOf: string[];
  /** At least one of these must appear — use it to accept synonyms. */
  anyOf: string[];
  /**
   * Terms that must *not* appear: the classic wrong answers ("reinstall Windows",
   * "chmod 777") are worth naming explicitly.
   */
  noneOf: string[];
  options: string[];
  expected: string;
  hint: string;
  placeholder: string;
  rows: number;
}

export function ticketFieldLabel(field: TicketField): string {
  return field.label || field.id;
}

export function ticketFieldIsChoice(field: TicketField): boolean {
  return (field.kind === "select" || field.kind === "checkbox") && field.options.length > 0;
}

function fieldKind(value: unknown): string {
  const kind = asText(value ?? "textarea").trim().toLowerCase();
  if (kind === "multiline") return "textarea";
  if (kind === "dropdown") return "select";
  return kind;
}

export function ticketFieldFromDict(data: Record<string, unknown>): TicketField {
  const kind = fieldKind(pyOr(data.kind, data.type, "textarea"));
  const rawOptions = pyOr(data.options, data.choices, []);
  const options = Array.isArray(rawOptions) ? rawOptions.map((option) => asText(option)) : [];
  const expected = asText(pyOr(data.expected, data.answer, "")).trim();
  const field: TicketField = {
    id: asText(data.id ?? "").trim(),
    label: asText(pyOr(data.label, data.question, "")).trim(),
    kind,
    weight: numberFrom(data.weight, 10),
    required: boolFrom(data.required, true),
    minWords: intFrom(data.min_words, 0),
    maxWords: intFrom(data.max_words, 0),
    allOf: asTerms(pyOr(data.all_of, data.keywords, data.contains)),
    anyOf: asTerms(pyOr(data.any_of, data.accept)),
    noneOf: asTerms(pyOr(data.none_of, data.reject)),
    options,
    expected,
    hint: asText(pyOr(data.hint, "")).trim(),
    placeholder: asText(pyOr(data.placeholder, "")).trim(),
    rows: intFrom(data.rows, 5),
  };
  // A select whose expected answer is in options is the common case; make the grader's
  // job explicit rather than implicit.
  if (ticketFieldIsChoice(field) && field.expected === "" && field.options.length > 0) {
    field.expected = field.options[0] ?? "";
  }
  return field;
}

/**
 * The field as the Python's `to_dict` wrote it — snake_case, and **without** `expected`.
 *
 * The rubric's answers are deliberately not in the stored view, the same choice
 * `ticketFormPublic` makes: a saved form is one that may be shown.
 */
export function ticketFieldToDict(field: TicketField): Record<string, unknown> {
  return {
    id: field.id,
    label: field.label,
    kind: field.kind,
    weight: field.weight,
    required: field.required,
    min_words: field.minWords,
    max_words: field.maxWords,
    all_of: [...field.allOf],
    any_of: [...field.anyOf],
    none_of: [...field.noneOf],
    options: [...field.options],
    hint: field.hint,
    placeholder: field.placeholder,
    rows: field.rows,
  };
}

/**
 * Accept `a`, `[a, b]` or `"a, b"` for a term list.
 *
 * Python's `_as_terms`, including its treatment of a bare string: a comma makes it a list,
 * otherwise it is one term.
 */
export function asTerms(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") {
    const parts = value.includes(",") ? value.split(",") : [value];
    return parts.map((part) => part.trim()).filter((part) => part !== "");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => asText(entry).trim()).filter((entry) => entry !== "");
  }
  if (value instanceof Set) {
    return [...value].map((entry) => asText(entry).trim()).filter((entry) => entry !== "");
  }
  return [asText(value).trim()];
}

/* -------------------------------------------------------------------------- */
/*  The form                                                                  */
/* -------------------------------------------------------------------------- */

/** The whole ticket a student has to complete. */
export interface TicketForm {
  title: string;
  intro: string;
  weight: number;
  fields: TicketField[];
  /** A short closing note the student can add (not graded, kept for the record). */
  closingLabel: string;
  passScore: number;
}

export function ticketFormTotalWeight(form: TicketForm): number {
  return form.fields.reduce((total, field) => total + field.weight, 0);
}

export function ticketFormField(form: TicketForm, fieldId: string): TicketField | null {
  return form.fields.find((field) => field.id === fieldId) ?? null;
}

export function ticketFormToDict(form: TicketForm): Record<string, unknown> {
  return {
    title: form.title,
    intro: form.intro,
    weight: form.weight,
    pass_score: form.passScore,
    closing_label: form.closingLabel,
    fields: form.fields.map(ticketFieldToDict),
  };
}

/**
 * Portal-facing view: the rubric weights are shown, the expected answers are not.
 *
 * The keys are the lab's (`min_words`, `max_words`), because this crosses into a template
 * and a second spelling here would be one more thing to keep in step.
 */
export function ticketFormPublic(form: TicketForm): Record<string, unknown> {
  return {
    title: form.title,
    intro: form.intro,
    weight: form.weight,
    pass_score: form.passScore,
    closing_label: form.closingLabel,
    fields: form.fields.map((field) => ({
      id: field.id,
      label: ticketFieldLabel(field),
      kind: field.kind,
      weight: field.weight,
      required: field.required,
      min_words: field.minWords,
      max_words: field.maxWords,
      options: [...field.options],
      hint: field.hint,
      placeholder: field.placeholder,
      rows: field.rows,
    })),
  };
}

/**
 * Build a `TicketForm` from a scenario's `ticket:` block.
 *
 * Returns `null` when the scenario declares no form, which is what makes the ticket
 * component optional rather than a new requirement on every scenario.
 */
export function loadForm(ticket: Record<string, unknown> | null | undefined): TicketForm | null {
  if (!isRecord(ticket)) return null;
  let raw = ticket.form;
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) raw = { fields: raw }; // the common shorthand
  if (!isRecord(raw)) throw new TicketError("ticket.form must be a mapping (or a list of fields)");
  const rawFields = raw.fields ?? [];
  const fields = (Array.isArray(rawFields) ? rawFields : [])
    .filter(isRecord)
    .map((item) => ticketFieldFromDict(item));
  return {
    title: asText(pyOr(raw.title, "Incident write-up")),
    intro: asText(pyOr(raw.intro, ticket.briefing, "")).trim(),
    weight: numberFrom(raw.weight, DEFAULT_TICKET_WEIGHT),
    fields,
    closingLabel: asText(pyOr(raw.closing_label, "Anything else? (not graded)")),
    // `float(raw.get("pass_score", 60.0))` — a value the Python would have raised on reads
    // as the default here, which is the one place this port is kinder than the original.
    passScore: numberFrom(raw.pass_score, 60.0),
  };
}

/** The field-id pattern: lowercase, dash/underscore separated. */
const FIELD_ID_RE = /^[a-z0-9][a-z0-9_]*$/;

/**
 * Static problems with a form. Called from scenario validation at build time.
 *
 * `prefix` is the scenario id's own bracket (`[net-dns-failure]`), so a problem points at
 * the manifest it came from. An empty form is assumed to be `null` by the caller rather
 * than reported here — a form this port was handed has already been found to exist.
 */
export function validateForm(form: TicketForm | null, prefix = "[ticket]"): string[] {
  if (form === null) return [];
  const problems: string[] = [];
  if (form.fields.length === 0) {
    problems.push(`${prefix} ticket.form declares no fields`);
    return problems;
  }
  if (!(form.weight > 0 && form.weight <= MAX_TICKET_WEIGHT)) {
    problems.push(
      `${prefix} ticket.form.weight must be in (0, ${gFormat(MAX_TICKET_WEIGHT)}] — the machine ` +
        "state is always the larger part of the grade",
    );
  }
  if (!(form.passScore > 0 && form.passScore <= 100)) { // pass-rule-exempt: a range check on the mark, not a verdict
    problems.push(`${prefix} ticket.form.pass_score must be in (0, 100]`);
  }
  const seen = new Set<string>();
  for (const field of form.fields) {
    if (RESERVED_FIELD_IDS.has(field.id)) {
      problems.push(
        `${prefix} field id ${pyRepr(field.id)} is reserved by the portal's write-up form ` +
          `(reserved: ${[...RESERVED_FIELD_IDS].sort().join(", ")}); it would share the ` +
          "form control the submit buttons use",
      );
    }
    if (!FIELD_ID_RE.test(field.id)) {
      problems.push(`${prefix} field id ${pyRepr(field.id)} must be lowercase, dash/underscore separated`);
    }
    if (seen.has(field.id)) problems.push(`${prefix} duplicate field id ${pyRepr(field.id)}`);
    seen.add(field.id);
    if (field.label === "") problems.push(`${prefix} field ${pyRepr(field.id)} has no label`);
    if (!(KINDS as readonly string[]).includes(field.kind)) {
      problems.push(
        `${prefix} field ${pyRepr(field.id)} kind ${pyRepr(field.kind)} must be one of: ${KINDS.join(", ")}`,
      );
    }
    if (field.weight <= 0) problems.push(`${prefix} field ${pyRepr(field.id)} needs weight > 0`);
    if (field.kind === "select" && field.options.length === 0) {
      problems.push(`${prefix} select field ${pyRepr(field.id)} needs options`);
    }
    if (field.minWords > 0 && field.maxWords > 0 && field.minWords > field.maxWords) {
      problems.push(`${prefix} field ${pyRepr(field.id)} min_words exceeds max_words`);
    }
    if (
      (field.kind === "text" || field.kind === "textarea") &&
      !(field.minWords > 0 || field.allOf.length > 0 || field.anyOf.length > 0 || field.required)
    ) {
      problems.push(
        `${prefix} free-text field ${pyRepr(field.id)} has no rubric (min_words/keywords); ` +
          "it would score full marks for an empty-ish answer",
      );
    }
  }
  const total = ticketFormTotalWeight(form);
  if (form.fields.length > 0 && Math.abs(total - 100) > 0.01) {
    problems.push(
      `${prefix} ticket field weights total ${gFormat(total)}, not 100 ` +
        "(the ticket score is a weighted percentage)",
    );
  }
  return problems;
}

/* -------------------------------------------------------------------------- */
/*  Grading                                                                   */
/* -------------------------------------------------------------------------- */

export interface TicketOutcome {
  fieldId: string;
  label: string;
  passed: boolean;
  detail: string;
  weight: number;
}

export function ticketOutcomeToDict(outcome: TicketOutcome): Record<string, unknown> {
  return {
    field_id: outcome.fieldId,
    label: outcome.label,
    passed: outcome.passed,
    detail: outcome.detail,
    weight: outcome.weight,
  };
}

export function ticketOutcomeFromDict(data: Record<string, unknown>): TicketOutcome {
  return {
    fieldId: asText(data.field_id ?? ""),
    label: asText(data.label ?? ""),
    passed: asBoolean(data.passed ?? false),
    detail: asText(data.detail ?? ""),
    weight: numberFrom(data.weight, 0),
  };
}

/** The marked ticket. */
export interface TicketGrade {
  sessionId: number;
  scenarioId: string;
  score: number;
  outcomes: TicketOutcome[];
  values: Record<string, string>;
  notes: string[];
  submitted: boolean;
  createdAt: string;
}

export function ticketGradePassedCount(grade: TicketGrade): number {
  return grade.outcomes.filter((outcome) => outcome.passed).length;
}

export function ticketGradeSummaryLine(grade: TicketGrade): string {
  if (!grade.submitted) return "no ticket submitted";
  return `${formatFixed(grade.score, 0)}% (${ticketGradePassedCount(grade)}/${grade.outcomes.length} fields)`;
}

export function ticketGradeToDict(grade: TicketGrade): Record<string, unknown> {
  return {
    session_id: grade.sessionId,
    scenario_id: grade.scenarioId,
    score: grade.score,
    submitted: grade.submitted,
    created_at: grade.createdAt,
    notes: [...grade.notes],
    values: { ...grade.values },
    outcomes: grade.outcomes.map(ticketOutcomeToDict),
  };
}

export function ticketGradeFromDict(data: Record<string, unknown>): TicketGrade {
  const rawOutcomes = Array.isArray(data.outcomes) ? data.outcomes : [];
  const rawValues = isRecord(data.values) ? data.values : {};
  const rawNotes = Array.isArray(data.notes) ? data.notes : [];
  return {
    sessionId: intFrom(data.session_id, 0),
    scenarioId: asText(data.scenario_id ?? ""),
    score: numberFrom(data.score, 0),
    outcomes: rawOutcomes.filter(isRecord).map(ticketOutcomeFromDict),
    values: Object.fromEntries(Object.entries(rawValues).map(([key, value]) => [String(key), asText(value)])),
    notes: rawNotes.map((note) => asText(note)),
    submitted: asBoolean(data.submitted ?? false),
    createdAt: asText(data.created_at ?? iso()),
  };
}

/** Words in a piece of prose, as the rubric counts them. */
export function wordCount(text: unknown): number {
  const matches = asText(text).match(WORD_RE);
  return matches === null ? 0 : matches.length;
}

/** The found and missing terms, case-insensitive substring match. */
function hits(haystack: string, terms: readonly string[]): { found: string[]; missing: string[] } {
  const low = haystack.toLowerCase();
  return {
    found: terms.filter((term) => low.includes(term.toLowerCase())),
    missing: terms.filter((term) => !low.includes(term.toLowerCase())),
  };
}

/** Mark one field against its rubric. */
export function gradeField(field: TicketField, rawValue: unknown): TicketOutcome {
  const value = asText(rawValue).trim();
  const outcome: TicketOutcome = {
    fieldId: field.id,
    label: ticketFieldLabel(field),
    passed: false,
    detail: "",
    weight: field.weight,
  };

  if (ticketFieldIsChoice(field)) {
    if (value === "") {
      outcome.detail = "no option chosen";
      return outcome;
    }
    if (field.options.length > 0 && !field.options.includes(value)) {
      outcome.detail = `unexpected option ${pyRepr(value)}`;
      return outcome;
    }
    if (field.expected !== "" && value !== field.expected) {
      outcome.detail = `chose ${pyRepr(value)}; the correct classification is ${pyRepr(field.expected)}`;
      return outcome;
    }
    outcome.passed = true;
    outcome.detail = `chose ${pyRepr(value)}`;
    return outcome;
  }

  if (value === "") {
    outcome.detail = field.required ? "left blank" : "left blank (optional)";
    outcome.passed = !field.required;
    return outcome;
  }

  const words = wordCount(value);
  if (field.minWords > 0 && words < field.minWords) {
    outcome.detail = `${words} word(s); a useful answer needs at least ${field.minWords}`;
    return outcome;
  }
  if (field.maxWords > 0 && words > field.maxWords) {
    outcome.detail = `${words} words; keep it under ${field.maxWords}`;
    return outcome;
  }

  const all = hits(value, field.allOf);
  if (all.missing.length > 0) {
    outcome.detail = `never mentions ${all.missing.join(", ")}`;
    return outcome;
  }

  if (field.anyOf.length > 0) {
    const any = hits(value, field.anyOf);
    if (any.missing.length === field.anyOf.length) {
      outcome.detail = `does not mention any of: ${field.anyOf.join(", ")}`;
      return outcome;
    }
  }

  const banned = hits(value, field.noneOf).found;
  if (banned.length > 0) {
    outcome.detail = `contains a rejected answer: ${banned.join(", ")}`;
    return outcome;
  }

  outcome.passed = true;
  outcome.detail = `${words} word(s) recorded`;
  return outcome;
}

/**
 * Mark a whole submission.
 *
 * A scenario with no form yields a zero-score, unsubmitted grade that says so in a note —
 * the honest outcome for "there was nothing to mark", and the reason `blend` can be called
 * unconditionally.
 */
export function grade(
  form: TicketForm | null,
  values: Record<string, unknown> | null | undefined,
  options: { sessionId?: number; scenarioId?: string } = {},
): TicketGrade {
  const answers = values ?? {};
  const result: TicketGrade = {
    sessionId: options.sessionId ?? 0,
    scenarioId: options.scenarioId ?? "",
    score: 0,
    outcomes: [],
    values: Object.fromEntries(Object.entries(answers).map(([key, value]) => [String(key), asText(value)])),
    notes: [],
    submitted: false,
    createdAt: iso(),
  };
  if (form === null) {
    result.notes.push("this scenario has no ticket form");
    return result;
  }

  result.submitted = Object.values(answers).some((value) => asText(value).trim() !== "");
  for (const field of form.fields) {
    result.outcomes.push(gradeField(field, answers[field.id] ?? ""));
  }

  const total = ticketFormTotalWeight(form) || 1.0;
  const earned = result.outcomes.reduce((sum, outcome) => sum + (outcome.passed ? outcome.weight : 0), 0);
  result.score = roundHalfEven((100.0 * earned) / total, 1);
  if (!result.submitted) result.notes.push("no ticket was submitted");
  return result;
}

/** Labels of required fields still empty — used to block submission in the portal. */
export function missingRequired(form: TicketForm, values: Record<string, unknown> | null | undefined): string[] {
  const answers = values ?? {};
  const missing: string[] = [];
  for (const field of form.fields) {
    if (!field.required) continue;
    const value = asText(answers[field.id] ?? "").trim();
    if (value === "") missing.push(ticketFieldLabel(field));
  }
  return missing;
}

/** Per-field feedback rows for the portal and the CLI. */
export function renderFeedback(form: TicketForm, result: TicketGrade): Record<string, unknown>[] {
  return result.outcomes.map((outcome) => {
    const field = ticketFormField(form, outcome.fieldId);
    return {
      field_id: outcome.fieldId,
      label: outcome.label,
      passed: outcome.passed,
      weight: outcome.weight,
      detail: outcome.detail,
      hint: field !== null && !outcome.passed ? field.hint : "",
    };
  });
}

/** The feedback as the plain text the CLI printed. */
export function feedbackText(form: TicketForm, result: TicketGrade): string {
  const lines = [
    `Ticket: ${form.title}`,
    `Score:  ${formatFixed(result.score, 1)}%  (${result.submitted ? "submitted" : "not submitted"})`,
    "",
  ];
  for (const row of renderFeedback(form, result)) {
    const mark = row.passed === true ? "PASS" : "FAIL";
    lines.push(`  [${mark}] ${row.label} (${formatFixed(Number(row.weight), 0)} pts)`);
    const detail = asText(row.detail);
    if (detail !== "") lines.push(`         ${detail}`);
  }
  return lines.join("\n");
}

/**
 * Combine the machine grade and the ticket grade into the final mark.
 *
 * `weight` is the ticket's share of the final grade. No submission means the ticket
 * contributes zero — which is the honest outcome: the work was not documented, so it does
 * not count as done.
 */
export function blend(machineScore: number, ticket: TicketGrade | null, weight: number): number {
  const share = Math.max(0.0, Math.min(Number(weight), MAX_TICKET_WEIGHT)) / 100.0;
  const ticketScore = ticket !== null && ticket.submitted ? ticket.score : 0.0;
  return roundHalfEven(machineScore * (1.0 - share) + ticketScore * share, 1);
}

/* -------------------------------------------------------------------------- */
/*  Small coercions, ported with the Python's rules                            */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python truthiness, which the original's `or` chains lean on. */
function pyFalsy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return true;
  if (value === 0 || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/**
 * Python's `a or b or c`.
 *
 * `data.get("kind") or data.get("type") or "textarea"` treats an empty string as absent,
 * which `??` does not — and the difference is a field whose `kind: ""` should have been
 * `textarea` being refused by validation instead.
 */
function pyOr(...values: unknown[]): unknown {
  for (const value of values) if (!pyFalsy(value)) return value;
  return values.length > 0 ? values[values.length - 1] : undefined;
}

/**
 * `str(value)` as this port needs it.
 *
 * A missing answer is `""` where Python's `str(None)` produced `"None"`; both are "no
 * answer" to every rubric here, and the divergence is only in the stored copy (see the
 * header).
 */
export function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

/** `bool(value)`: the Python truthiness of a stored flag. */
function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["true", "yes", "1", "pass", "passed", "ok"].includes(asText(value).trim().toLowerCase());
}

/**
 * `float(...)`/`int(...)` with Python's default when the value is absent.
 *
 * An absent key gets the default (Python's `data.get("rows", 5)`); an empty string gets it
 * too, where Python's `int("")` raised — the one place this port is kinder than the
 * original, named here rather than left to be found.
 */
function numberFrom(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" && value.trim() === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intFrom(value: unknown, fallback: number): number {
  return Math.trunc(numberFrom(value, fallback));
}

function boolFrom(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback;
  return asBoolean(value);
}

/** Python's `{value:g}` for the small weights and scores this module formats. */
function gFormat(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? value.toFixed(0) : String(value);
}

/** Python's `{value!r}` for a word: the quotes a message needs, and the same spelling. */
function pyRepr(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${escaped}'`;
}
