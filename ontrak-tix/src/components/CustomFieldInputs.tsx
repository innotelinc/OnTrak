/**
 * The desk's own fields, rendered into whatever form is raising the ticket.
 *
 * A plain server component with no client state, because the fields are just inputs and
 * the browser already knows how to fill them in: a `required` attribute for a required
 * field, the right `type` for each kind, and a section heading where the desk put one.
 * Nothing here validates — `FormService.validateTicketValues` does, on the way in — so a
 * browser that ignores `required` still cannot store a blank answer.
 *
 * The values are posted as `custom:<key>`, which keeps the desk's field names from
 * colliding with the form's own (`subject`, `priority`, …) whatever a desk calls a field.
 */
import type { FormLayout, ResolvedField } from "../lib/form-rules";
import { customFieldName } from "../lib/form-payload";

const INPUT_CLASS = "mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink";

function FieldInput({ field }: { field: ResolvedField }) {
  const name = customFieldName(field.key);
  const help = field.helpText ? (
    <span className="mt-1 block text-xs text-ink-faint">{field.helpText}</span>
  ) : null;

  if (field.type === "CHECKBOX") {
    return (
      <label className="flex items-start gap-2 text-sm font-medium text-ink">
        <input type="checkbox" name={name} value="on" className="mt-1" />
        <span>
          {field.label}
          {field.required ? <span className="text-bad"> *</span> : null}
          {help}
        </span>
      </label>
    );
  }

  const label = (
    <span className="block text-sm font-medium text-ink">
      {field.label}
      {field.required ? <span className="text-bad"> *</span> : null}
    </span>
  );

  if (field.type === "TEXTAREA") {
    return (
      <label className="block">
        {label}
        <textarea
          name={name}
          rows={4}
          required={field.required}
          placeholder={field.placeholder}
          className={INPUT_CLASS}
        />
        {help}
      </label>
    );
  }

  if (field.type === "SELECT") {
    return (
      <label className="block">
        {label}
        <select name={name} required={field.required} defaultValue="" className={INPUT_CLASS}>
          <option value="">{field.required ? "Choose one" : "—"}</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {help}
      </label>
    );
  }

  const inputType = field.type === "NUMBER" ? "number" : field.type === "DATE" ? "date" : "text";
  return (
    <label className="block">
      {label}
      <input
        type={inputType}
        name={name}
        required={field.required}
        placeholder={field.placeholder}
        className={INPUT_CLASS}
      />
      {help}
    </label>
  );
}

/**
 * The form's sections. Nothing is rendered at all when the desk has no fields, so a stack
 * that has never defined one sees the page exactly as it was.
 */
export function CustomFieldInputs({ layout }: { layout: FormLayout }) {
  if (layout.fields.length === 0) return null;

  return (
    <div className="space-y-4 rounded-xl2 border border-line bg-surface-muted/40 p-4">
      {layout.sections.map((section) => (
        <fieldset key={section.title} className="space-y-4">
          {layout.sections.length > 1 || section.title !== "Details" ? (
            <legend className="text-xs font-semibold tracking-wide text-ink-faint uppercase">{section.title}</legend>
          ) : null}
          {section.fields.map((field) => (
            <FieldInput key={field.key} field={field} />
          ))}
        </fieldset>
      ))}
    </div>
  );
}
