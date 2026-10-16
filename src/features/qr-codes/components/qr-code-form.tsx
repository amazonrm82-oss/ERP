"use client";

import { useActionState } from "react";

import { SelectField, TextField } from "@/components/ui/field";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { createQrCodeAction } from "../actions";
import type { QrTargetOption } from "../queries";

const optionLabel = (option: QrTargetOption) => (option.active ? option.label : `${option.label} (כבוי)`);

/** BIZ-03: a new code: its name (the sign or flyer it goes on) and what it opens. */
export function QrCodeForm({ orgId, forms, pages }: { orgId: string; forms: QrTargetOption[]; pages: QrTargetOption[] }) {
  const [state, formAction] = useActionState<FormState, FormData>(createQrCodeAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextField
        label="שם הקוד"
        name="name"
        maxLength={80}
        required
        hint="למשל: שלט בחלון, פלייר בכנס. השם נשמר בליד כקמפיין, כך שרואים מאיזה קוד הגיע."
        defaultValue={values?.name ?? ""}
        error={failure?.fieldErrors?.name}
      />
      <SelectField label="מה הקוד פותח" name="target" required defaultValue={values?.target ?? ""} error={failure?.fieldErrors?.target}>
        <option value="" disabled>
          בחירה…
        </option>
        {forms.length > 0 ? (
          <optgroup label="טפסים">
            {forms.map((option) => (
              <option key={option.value} value={option.value}>
                {optionLabel(option)}
              </option>
            ))}
          </optgroup>
        ) : null}
        {pages.length > 0 ? (
          <optgroup label="דפי קביעת תור">
            {pages.map((option) => (
              <option key={option.value} value={option.value}>
                {optionLabel(option)}
              </option>
            ))}
          </optgroup>
        ) : null}
      </SelectField>
      <SubmitButton>יצירת הקוד</SubmitButton>
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
    </form>
  );
}
