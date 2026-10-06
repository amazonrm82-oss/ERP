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
                <label className="flex min-h-11 items-center gap-2.5 text-[0.9375rem]">
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
