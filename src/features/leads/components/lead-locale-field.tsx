import { SelectField } from "@/components/ui/field";
import { LOCALE_OPTIONS } from "@/features/contacts/preferences";

/** CAP-08: the lead's preferred language (the contacts' list); distribution rules may use it. */
export function LeadLocaleField({ value, error }: { value: string; error?: string }) {
  return (
    <SelectField key={`locale-${value}`} label="שפה מועדפת" name="preferred_locale" defaultValue={value} error={error} className="sm:max-w-xs">
      <option value="">לא צוינה</option>
      {LOCALE_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </SelectField>
  );
}
