"use client";

import { useActionState } from "react";

import { FormError } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { TEAM_SIZES } from "@/features/onboarding/options";
import { VISIBILITY_OPTIONS } from "@/features/settings/permissions";
import type { OrganizationSettings } from "@/features/settings/queries";
import type { FormState } from "@/lib/action-result";

import { saveSetupDetailsAction } from "../actions";

type Props = { orgId: string; settings: OrganizationSettings };

/** Step 1: the details the business details page edits, without the industry (step 2). */
export function DetailsStepForm({ orgId, settings }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveSetupDetailsAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const teamSize = values?.team_size ?? settings.teamSize ?? "";
  const visibility = values?.record_visibility ?? settings.recordVisibility;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <TextField
        label="שם העסק"
        name="name"
        autoComplete="organization"
        required
        maxLength={120}
        defaultValue={values?.name ?? settings.name}
        error={errors.name}
      />
      {/* key: a select only takes defaultValue on mount */}
      <SelectField key={`team-${teamSize}`} label="גודל צוות" name="team_size" defaultValue={teamSize} error={errors.team_size}>
        <option value="">לא נבחר</option>
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
        inputMode="tel"
        autoComplete="tel"
        defaultValue={values?.phone ?? settings.phone ?? ""}
        error={errors.phone}
      />
      <fieldset
        key={`visibility-${visibility}`}
        role="radiogroup"
        aria-describedby={errors.record_visibility ? "setup-visibility-note setup-visibility-error" : "setup-visibility-note"}
        aria-invalid={errors.record_visibility ? true : undefined}
      >
        <legend className="mb-1 font-medium">מי רואה את הרשומות</legend>
        <p id="setup-visibility-note" className="mb-3 text-sm text-ink-soft">
          חל על לידים, אנשי קשר, חברות ועסקאות. בעלים ומנהלי מערכת תמיד רואים הכול.
        </p>
        <div className="space-y-2">
          {VISIBILITY_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer gap-3 rounded-md border border-line p-3 has-checked:border-accent has-checked:bg-accent-soft"
            >
              <input
                type="radio"
                name="record_visibility"
                value={option.value}
                defaultChecked={visibility === option.value}
                className="mt-1 size-4 shrink-0 accent-accent"
              />
              <span>
                <span className="block font-medium">{option.label}</span>
                <span className="block text-sm text-ink-soft">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
        {errors.record_visibility ? (
          <p id="setup-visibility-error" className="mt-2 text-sm text-danger">
            {errors.record_visibility}
          </p>
        ) : null}
      </fieldset>

      <FormError message={failure?.message} />
      <SubmitButton>שמירה והמשך</SubmitButton>
    </form>
  );
}
