import { SelectField } from "@/components/ui/field";

import { GENDER_OPTIONS } from "../gender";

/**
 * HEB-01: the optional gender of a lead or a contact. Empty by default and never filled by the system;
 * WhatsApp templates use it to pick a wording, and the neutral one when it is not set.
 */
export function GenderField({ value, error, className }: { value: string; error?: string; className?: string }) {
  return (
    <SelectField
      key={`gender-${value}`}
      label="מגדר (לנוסח ההודעות)"
      name="gender"
      defaultValue={value}
      error={error}
      className={className}
    >
      <option value="">לא צוין</option>
      {GENDER_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </SelectField>
  );
}
