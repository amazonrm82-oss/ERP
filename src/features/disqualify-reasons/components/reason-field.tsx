"use client";

import { Input, Select, SelectField, TextField } from "@/components/ui/field";

type Props = {
  // the organization's active reasons; empty: any reason is typed in, as before (LEAD-03)
  reasons: string[];
  label: string;
  value: string;
  onChange: (value: string) => void;
  // "field": a labelled field; "bare": a small control named by aria-label (a list cell, the bulk bar)
  variant?: "field" | "bare";
  controlSize?: "md" | "sm";
  hideLabel?: boolean;
  name?: string;
  error?: string;
  autoFocus?: boolean;
  className?: string;
};

/** The reason a lead is not relevant: a choice from the organization's list, or free text while it has none. */
export function DisqualifyReasonField({ reasons, label, value, onChange, variant = "field", controlSize = "md", hideLabel, name, error, autoFocus, className }: Props) {
  if (reasons.length > 0) {
    const options = (
      <>
        <option value="">בחירת סיבה</option>
        {reasons.map((reason) => (
          <option key={reason} value={reason}>
            {reason}
          </option>
        ))}
      </>
    );
    return variant === "bare" ? (
      <Select aria-label={label} controlSize={controlSize} name={name} value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} className={className}>
        {options}
      </Select>
    ) : (
      <SelectField
        label={label}
        hideLabel={hideLabel}
        controlSize={controlSize}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        error={error}
        autoFocus={autoFocus}
        required
        className={className}
      >
        {options}
      </SelectField>
    );
  }
  return variant === "bare" ? (
    <Input
      aria-label={label}
      placeholder="למה לא רלוונטי?"
      controlSize={controlSize}
      name={name}
      maxLength={500}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoFocus={autoFocus}
      className={className}
    />
  ) : (
    <TextField
      label={label}
      hideLabel={hideLabel}
      controlSize={controlSize}
      name={name}
      maxLength={500}
      autoComplete="off"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      error={error}
      autoFocus={autoFocus}
      required
      className={className}
    />
  );
}
