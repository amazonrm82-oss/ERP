import { SelectField } from "@/components/ui/field";
import { CHANNEL_OPTIONS } from "@/features/contacts/preferences";

/** CON-10: the lead's preferred channel, as on the contact form (display only; nothing sends by it yet). */
export function LeadChannelField({ value, error }: { value: string; error?: string }) {
  return (
    <SelectField key={`channel-${value}`} label="ערוץ מועדף" name="preferred_channel" defaultValue={value} error={error} className="sm:max-w-xs">
      <option value="">לא צוין</option>
      {CHANNEL_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </SelectField>
  );
}
