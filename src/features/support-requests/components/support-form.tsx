"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { sendSupportRequestAction } from "../actions";
import { SUPPORT_CATEGORIES, SUPPORT_MESSAGE_MAX, SUPPORT_SUBJECT_MAX } from "../categories";

/**
 * USR-12: the support request form. `page` is the screen the person came from (a path of this site, read by the server
 * from the request), offered ticked.
 */
export function SupportForm({ orgId, page }: { orgId: string; page: string | null }) {
  const [state, formAction] = useActionState<FormState<number>, FormData>(sendSupportRequestAction.bind(null, orgId), null);
  const failed = state && !state.ok ? state : null;
  const values = failed?.values ?? {};

  return (
    // a sent request empties the form: each answer has its own key
    <form key={state?.ok ? `sent-${state.data}` : "form"} action={formAction} className="space-y-4">
      <FormError message={failed?.message ?? null} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SelectField label="נושא" name="category" defaultValue={values.category ?? "question"} error={failed?.fieldErrors?.category} required>
        {Object.entries(SUPPORT_CATEGORIES).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </SelectField>
      <TextField label="כותרת" name="subject" maxLength={SUPPORT_SUBJECT_MAX} defaultValue={values.subject ?? ""} error={failed?.fieldErrors?.subject} required />
      <TextareaField
        label="מה קרה, או במה אפשר לעזור?"
        name="message"
        rows={6}
        maxLength={SUPPORT_MESSAGE_MAX}
        defaultValue={values.message ?? ""}
        error={failed?.fieldErrors?.message}
        hint={`עד ${SUPPORT_MESSAGE_MAX.toLocaleString("he-IL")} תווים. אין צורך לצרף פרטים של הלקוחות שלכם, אלא אם בלעדיהם אי אפשר להבין.`}
        required
      />
      {page ? (
        <>
          <input type="hidden" name="page_path" value={page} />
          <Checkbox
            name="include_page"
            defaultChecked
            label="לצרף את הדף שהייתי בו"
            hint={page}
          />
        </>
      ) : null}
      <SubmitButton pendingText="שולחים…">שליחת הפנייה</SubmitButton>
    </form>
  );
}
