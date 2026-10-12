import { SelectField } from "@/components/ui/field";

import { typeChoices, type RecordType } from "../schema";

type Props = {
  types: RecordType[];
  // the record's type and its older free-text type (contact_type / company_type), shown while no type is set
  value: string | null | undefined;
  legacy?: string | null;
  label: string;
  error?: string;
  className?: string;
};

/**
 * The type of a contact or company (CON-02), picked from the organization's
 * list. Left out when the list is empty, so the record's type is not touched.
 */
export function RecordTypeField({ types, value, legacy, label, error, className }: Props) {
  const current = value ?? "";
  const choices = typeChoices(types, current || null);
  if (choices.length === 0) {
    return null;
  }
  const hint = !current && legacy ? `נרשם קודם: ${legacy}` : undefined;
  return (
    // key: a select only takes defaultValue on mount
    <SelectField key={`type-${current}`} label={label} name="type_id" defaultValue={current} hint={hint} error={error} className={className}>
      <option value="">ללא סוג</option>
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </SelectField>
  );
}
