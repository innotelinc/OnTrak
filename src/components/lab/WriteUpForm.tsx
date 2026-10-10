import { Alert, Badge, Button, Field, Input, Select, Textarea } from "@/components/ui";
import {
  WRITEUP_ACTION,
  renderFeedback,
  ticketFieldIsChoice,
  ticketFieldLabel,
  ticketGradeSummaryLine,
  wordCount,
  type TicketField,
  type TicketForm,
  type TicketGrade,
} from "@/lib/lab/tickets";

/**
 * The in-house ticket, as the student fills it in.
 *
 * One form with three submitting buttons — save, preview, hand in — because nested forms
 * are not a thing and duplicating every field for a second button would be worse. Which
 * button was pressed travels as `WRITEUP_ACTION`, not as `action`: `action` is a field name
 * scenarios define themselves, and shadowing it would make a scenario's own field decide
 * whether the machine is destroyed.
 *
 * Presentational on purpose. The action is a prop rather than an import so the form can be
 * rendered (and audited by axe, see `tests/a11y.test.ts`) with no server action, no
 * database and no lab behind it — which is the only way an accessibility sweep can cover a
 * surface that otherwise needs a hypervisor to exist.
 */
export function WriteUpForm({
  sessionId,
  form,
  answers,
  preview,
  action,
  disabled = false,
}: {
  sessionId: number;
  form: TicketForm;
  /** Whatever the student has typed, from the draft the store keeps. */
  answers: Record<string, string>;
  /** The mark from a *preview*, never from a stored submission. */
  preview: TicketGrade | null;
  action: (formData: FormData) => Promise<void>;
  /** A session that is already handed in keeps its answers readable but uneditable. */
  disabled?: boolean;
}) {
  const rows = preview === null ? [] : renderFeedback(form, preview);

  return (
    <form action={action} className="space-y-4">
      {/* `aria-hidden` as well as `type="hidden"`: a field nobody can perceive is not an
          interactive control, and saying so keeps an accessibility sweep from reporting it
          as an unnamed one. */}
      <input type="hidden" name="sessionId" value={sessionId} aria-hidden="true" />

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{form.title}</h3>
        <span className="text-xs text-ink-faint">
          {form.weight}% of this grade · {form.fields.length} field
          {form.fields.length === 1 ? "" : "s"}
        </span>
      </div>

      {rows.length > 0 ? (
        <Alert tone={preview?.submitted ? "teal" : "amber"} title={`Write-up preview: ${preview === null ? "" : ticketGradeSummaryLine(preview)}`}>
          This is not recorded. It is marked with the machine when you hand the session in.
        </Alert>
      ) : null}

      {form.fields.map((field) => (
        <TicketQuestion
          key={field.id}
          field={field}
          value={answers[field.id] ?? ""}
          outcome={rows.find((row) => row.field_id === field.id)}
          disabled={disabled}
        />
      ))}

      {disabled ? (
        <p className="text-xs text-ink-faint">This session has been handed in; the write-up is read-only.</p>
      ) : (
        // `name` and `value` are what the action reads: the browser only ever sends the
        // button it actually clicked, and a POST with no button is defaulted to the
        // non-destructive action on the server side.
        <div className="flex flex-wrap gap-2">
          <Button type="submit" name={WRITEUP_ACTION} value="save" variant="secondary">
            Save draft
          </Button>
          <Button type="submit" name={WRITEUP_ACTION} value="preview" variant="secondary">
            Preview my mark
          </Button>
          <Button type="submit" name={WRITEUP_ACTION} value="submit">
            Complete &amp; End
          </Button>
        </div>
      )}
    </form>
  );
}

/** One rubric field, in the control its `kind` asks for. */
function TicketQuestion({
  field,
  value,
  outcome,
  disabled,
}: {
  field: TicketField;
  value: string;
  outcome: Record<string, unknown> | undefined;
  disabled: boolean;
}) {
  const id = `ticket-${field.id}`;
  const hint =
    field.kind === "textarea" && field.minWords > 0
      ? `${wordCount(value)}/${field.minWords} words minimum`
      : field.weight > 0
        ? `${field.weight} pts`
        : undefined;
  const error =
    outcome !== undefined && outcome.passed !== true
      ? String(outcome.detail ?? "")
      : undefined;

  return (
    <Field
      label={ticketFieldLabel(field)}
      htmlFor={id}
      hint={
        <>
          {hint}
          {field.required ? <span className="text-pink"> *</span> : null}
        </>
      }
      error={error}
    >
      {control(field, id, value, disabled, ticketFieldLabel(field))}
      {outcome !== undefined && outcome.passed !== true && field.hint !== "" ? (
        <span className="mt-1.5 block text-xs text-ink-faint">Hint: {field.hint}</span>
      ) : null}
    </Field>
  );
}

/**
 * One field's control.
 *
 * Every control carries an explicit `aria-label` as well as sitting inside its `<label>`.
 * Both is on purpose: the wrapping label is the association a sighted keyboard user gets,
 * and the explicit name survives the case a screen reader reaches the control out of
 * context — which is the case the accessibility sweep asserts (`assertControlsNamed` in
 * `tests/a11y.test.ts`), and the same thing the simulator's own console controls do.
 */
function control(
  field: TicketField,
  id: string,
  value: string,
  disabled: boolean,
  label: string,
): React.ReactNode {
  if (ticketFieldIsChoice(field)) {
    return (
      <Select id={id} name={field.id} aria-label={label} defaultValue={value} disabled={disabled}>
        <option value="">Choose…</option>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    );
  }
  if (field.kind === "checkbox") {
    return (
      <span className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          name={field.id}
          aria-label={label}
          value={field.expected || "yes"}
          defaultChecked={value !== ""}
          disabled={disabled}
          className="size-4 rounded border-line"
        />
        <Badge tone="neutral">{field.expected || "yes"}</Badge>
      </span>
    );
  }
  if (field.kind === "number") {
    return (
      <Input
        id={id}
        type="number"
        name={field.id}
        aria-label={label}
        defaultValue={value}
        disabled={disabled}
      />
    );
  }
  if (field.kind === "text") {
    return (
      <Input
        id={id}
        type="text"
        name={field.id}
        aria-label={label}
        defaultValue={value}
        placeholder={field.placeholder}
        disabled={disabled}
      />
    );
  }
  return (
    <Textarea
      id={id}
      name={field.id}
      aria-label={label}
      defaultValue={value}
      rows={field.rows > 0 ? field.rows : 5}
      placeholder={field.placeholder}
      disabled={disabled}
    />
  );
}
