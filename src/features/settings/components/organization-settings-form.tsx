"use client";

import { useActionState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { INDUSTRIES, TEAM_SIZES } from "@/features/onboarding/options";
import type { FormState } from "@/lib/action-result";

import { updateOrganizationAction } from "../actions";
import { VISIBILITY_OPTIONS } from "../permissions";
import type { OrganizationSettings } from "../queries";

type Props = { orgId: string; settings: OrganizationSettings };

/** Business details and record visibility. Admins only; the page shows a read-only view to others. */
export function OrganizationSettingsForm({ orgId, settings }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(updateOrganizationAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const industry = values?.industry ?? settings.industry ?? "";
  const teamSize = values?.team_size ?? settings.teamSize ?? "";
  const visibility = values?.record_visibility ?? settings.recordVisibility;

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <Card aria-labelledby="org-details-title">
        <CardHeader id="org-details-title" title="פרטי העסק" />
        <CardBody className="space-y-4">
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
          <SelectField key={`industry-${industry}`} label="ענף" name="industry" defaultValue={industry} error={errors.industry}>
            <option value="">לא נבחר</option>
            {INDUSTRIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>
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
        </CardBody>
      </Card>

      <Card aria-labelledby="visibility-title">
        <CardHeader id="visibility-title" title="מי רואה את הרשומות" />
        <CardBody>
          <fieldset key={`visibility-${visibility}`} aria-describedby="visibility-note">
            <legend className="sr-only">מי רואה את הרשומות</legend>
            <p id="visibility-note" className="mb-3 text-sm text-ink-soft">
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
            {errors.record_visibility ? <p className="mt-2 text-sm text-danger">{errors.record_visibility}</p> : null}
          </fieldset>
        </CardBody>
      </Card>

      <FormError message={failure?.message} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SubmitButton>שמירה</SubmitButton>
    </form>
  );
}
