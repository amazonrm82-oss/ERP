"use client";

import { useActionState } from "react";

import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { INDUSTRIES } from "@/features/onboarding/options";
import type { FormState } from "@/lib/action-result";

import { saveSetupIndustryAction } from "../actions";

type Props = { orgId: string; industry: string | null };

/** Step 2: the industry of the business (the same list as the sign-up form and the business details page). */
export function IndustryStepForm({ orgId, industry }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveSetupIndustryAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const value = failure?.values?.industry ?? industry ?? "";

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <SelectField
        key={`industry-${value}`}
        label="ענף"
        name="industry"
        hint="אפשר לשנות אחר כך בפרטי העסק."
        defaultValue={value}
        error={failure?.fieldErrors?.industry}
      >
        <option value="">לא נבחר</option>
        {INDUSTRIES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      <FormError message={failure?.message} />
      <SubmitButton>שמירה והמשך</SubmitButton>
    </form>
  );
}
