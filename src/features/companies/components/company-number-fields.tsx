"use client";

import { useState } from "react";

import { SelectField, TextField } from "@/components/ui/field";

import { COUNTRIES, ISRAEL, countryName } from "../countries";

type Props = {
  country?: string | null;
  taxId?: string | null;
  errors: Record<string, string>;
};

/**
 * The company's country and registration number (CON-04). In Israel the number
 * is a ח.פ. or ע.מ. with a check digit; abroad only its shape is checked, so the
 * hint and the phone keyboard follow the chosen country.
 */
export function CompanyNumberFields({ country, taxId, errors }: Props) {
  const initial = country || ISRAEL;
  const [current, setCurrent] = useState(initial);
  const israeli = current === ISRAEL;
  // a stored code that is not in the list is shown so the form opens on it, but the
  // schema refuses it (isCountryCode): to save, the user picks a country from the list
  const unknown = countryName(initial) === initial;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <SelectField
        label="מדינת הרישום"
        name="country"
        value={current}
        onChange={(event) => setCurrent(event.target.value)}
        error={errors.country}
      >
        {unknown ? <option value={initial}>{initial}</option> : null}
        {COUNTRIES.map((option) => (
          <option key={option.code} value={option.code}>
            {option.name}
          </option>
        ))}
      </SelectField>
      <TextField
        label="ח.פ. / מספר רישום"
        name="tax_id"
        hint={israeli ? "ח.פ. או עוסק מורשה, 9 ספרות" : "מספר הרישום במדינה של החברה, באותיות באנגלית ובספרות"}
        dir="ltr"
        inputMode={israeli ? "numeric" : "text"}
        maxLength={30}
        autoComplete="off"
        defaultValue={taxId ?? ""}
        error={errors.tax_id}
      />
    </div>
  );
}
