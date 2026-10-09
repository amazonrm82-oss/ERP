import { SelectField, TextareaField, TextField } from "@/components/ui/field";

import { inputName, type CustomValues, type FieldDefinition } from "../types";
import { inputValue } from "../values";

type Props = {
  definitions: FieldDefinition[];
  // stored values of the record (edit forms)
  stored?: CustomValues;
  // what the user typed, after a failed submit (keyed by input name)
  submitted?: Record<string, string>;
  errors?: Record<string, string>;
};

/** Inputs for a record's active custom fields. Renders nothing when there are none. */
export function CustomFieldInputs({ definitions, stored = {}, submitted, errors = {} }: Props) {
  if (definitions.length === 0) {
    return null;
  }
  return (
    <fieldset className="space-y-4 border-t border-line pt-4">
      <legend className="sr-only">שדות נוספים</legend>
      {definitions.map((field) => {
        const name = inputName(field.key);
        const value = submitted ? (submitted[name] ?? "") : inputValue(field, stored);
        const common = {
          label: field.label,
          name,
          required: field.isRequired,
          hint: field.helpText ?? undefined,
          error: errors[name],
        };
        switch (field.type) {
          case "long_text":
            return <TextareaField key={field.id} {...common} maxLength={5000} defaultValue={value} />;
          case "select":
            return (
              <SelectField key={`${field.id}-${value}`} {...common} defaultValue={value}>
                <option value="">לא נבחר</option>
                {field.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </SelectField>
            );
          case "checkbox":
            return (
              <div key={`${field.id}-${value}`}>
                <label className="flex min-h-11 items-center gap-2.5 text-md">
                  <input type="checkbox" name={name} defaultChecked={value === "on"} className="size-4.5 accent-accent" />
                  {field.label}
                  {field.isRequired ? (
                    <span aria-hidden="true" className="text-danger">
                      *
                    </span>
                  ) : null}
                </label>
                {errors[name] ? <p className="text-sm text-danger">{errors[name]}</p> : null}
                {field.helpText ? <p className="text-sm text-ink-soft">{field.helpText}</p> : null}
              </div>
            );
          case "multi_select": {
            const picked = value.split("\n");
            return (
              <fieldset key={`${field.id}-${value}`} aria-describedby={errors[name] ? `${name}-error` : undefined}>
                <legend className="mb-1.5 text-sm font-medium">
                  {field.label}
                  {field.isRequired ? (
                    <span aria-hidden="true" className="ms-0.5 text-danger">
                      *
                    </span>
                  ) : null}
                </legend>
                <div className="flex flex-wrap gap-x-4">
                  {field.options.map((option) => (
                    <label key={option} className="flex min-h-11 items-center gap-2 text-md">
                      <input type="checkbox" name={name} value={option} defaultChecked={picked.includes(option)} className="size-4.5 accent-accent" />
                      {option}
                    </label>
                  ))}
                </div>
                {errors[name] ? (
                  <p id={`${name}-error`} className="text-sm text-danger">
                    {errors[name]}
                  </p>
                ) : null}
                {field.helpText ? <p className="text-sm text-ink-soft">{field.helpText}</p> : null}
              </fieldset>
            );
          }
          case "rating":
            return (
              <SelectField key={`${field.id}-${value}`} {...common} defaultValue={value}>
                <option value="">לא נבחר</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={String(n)}>
                    {n} מתוך 5
                  </option>
                ))}
              </SelectField>
            );
          case "user":
            return (
              <SelectField key={`${field.id}-${value}`} {...common} defaultValue={value}>
                <option value="">לא נבחר</option>
                {(field.choices ?? []).map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </SelectField>
            );
          case "currency":
            return <TextField key={field.id} {...common} hint={field.helpText ?? "בשקלים"} dir="ltr" inputMode="decimal" autoComplete="off" defaultValue={value} />;
          case "percent":
            return <TextField key={field.id} {...common} hint={field.helpText ?? "באחוזים"} dir="ltr" inputMode="decimal" autoComplete="off" defaultValue={value} />;
          case "datetime":
            return <TextField key={field.id} {...common} type="datetime-local" defaultValue={value} />;
          case "il_id":
          case "il_company_id":
            return <TextField key={field.id} {...common} dir="ltr" inputMode="numeric" maxLength={11} autoComplete="off" defaultValue={value} />;
          case "date":
            return <TextField key={field.id} {...common} type="date" defaultValue={value} />;
          case "number":
            return <TextField key={field.id} {...common} dir="ltr" inputMode="decimal" autoComplete="off" defaultValue={value} />;
          case "phone":
            return <TextField key={field.id} {...common} type="tel" dir="ltr" inputMode="tel" autoComplete="off" defaultValue={value} />;
          case "email":
            return <TextField key={field.id} {...common} type="email" dir="ltr" inputMode="email" autoComplete="off" defaultValue={value} />;
          case "url":
            return <TextField key={field.id} {...common} dir="ltr" inputMode="url" autoComplete="off" defaultValue={value} />;
          default:
            return <TextField key={field.id} {...common} maxLength={500} autoComplete="off" defaultValue={value} />;
        }
      })}
    </fieldset>
  );
}
