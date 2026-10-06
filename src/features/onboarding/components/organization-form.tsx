"use client";

import { useActionState } from "react";

import { FormError } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { createOrganizationAction } from "../actions";
import { INDUSTRIES, TEAM_SIZES } from "../options";

export function OrganizationForm() {
  const [state, formAction] = useActionState<FormState, FormData>(createOrganizationAction, null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values ?? {};
  const errors = failure?.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure?.message} />
      <TextField
        label="שם העסק"
        name="name"
        autoComplete="organization"
        required
        maxLength={120}
        defaultValue={values.name}
        error={errors.name}
      />
      {/* key: a select only takes defaultValue on mount, so remount it with the returned values */}
      <SelectField key={`industry-${values.industry ?? ""}`} label="ענף" name="industry" defaultValue={values.industry ?? ""} error={errors.industry}>
        <option value="">בחירת ענף</option>
        {INDUSTRIES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      <SelectField
        key={`team-${values.team_size ?? ""}`}
        label="כמה אנשים יעבדו במערכת?"
        name="team_size"
        defaultValue={values.team_size ?? ""}
        error={errors.team_size}
      >
        <option value="">בחירת גודל צוות</option>
        {TEAM_SIZES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      <TextField
        label="טלפון העסק"
        name="phone"
        type="tel"
        dir="ltr"
        autoComplete="tel"
        inputMode="tel"
        defaultValue={values.phone}
        error={errors.phone}
      />
      <SubmitButton pendingText="מקים את העסק…" className="w-full">
        יצירת העסק והמשך
      </SubmitButton>
    </form>
  );
}
