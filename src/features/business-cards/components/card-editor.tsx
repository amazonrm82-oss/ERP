"use client";

import { useActionState } from "react";

import { Checkbox, TextareaField, TextField } from "@/components/ui/field";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveCardAction } from "../actions";
import { CARD_FIELDS, DEFAULT_PUBLIC_FIELDS } from "../model";
import type { BusinessCard } from "../queries";

/** BIZ-02: a rep's card details, and which of them the card shows. */
export function CardEditor({ orgId, userId, card }: { orgId: string; userId: string; card: BusinessCard | null }) {
  const [state, formAction] = useActionState<FormState, FormData>(saveCardAction.bind(null, orgId, userId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const shown = new Set<string>(card?.publicFields ?? DEFAULT_PUBLIC_FIELDS);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextField label="תפקיד" name="job_title" maxLength={80} defaultValue={values?.job_title ?? card?.jobTitle ?? ""} error={failure?.fieldErrors?.job_title} />
      <TextareaField label="כמה מילים עליי" name="about" rows={3} maxLength={500} defaultValue={values?.about ?? card?.about ?? ""} error={failure?.fieldErrors?.about} />
      <TextField label="טלפון" name="phone" type="tel" dir="ltr" maxLength={40} defaultValue={values?.phone ?? card?.phone ?? ""} error={failure?.fieldErrors?.phone} />
      <TextField label="אימייל" name="email" type="email" dir="ltr" maxLength={254} defaultValue={values?.email ?? card?.email ?? ""} error={failure?.fieldErrors?.email} />
      <TextField label="אתר" name="website" type="url" dir="ltr" maxLength={300} placeholder="https://" defaultValue={values?.website ?? card?.website ?? ""} error={failure?.fieldErrors?.website} />
      <fieldset className="space-y-2">
        <legend className="mb-1 text-md font-medium">מה מופיע בכרטיס</legend>
        <p className="text-sm text-ink-soft">השם שלך, שם העסק והלוגו מופיעים תמיד. פרט שלא סימנת לא יוצא מהמערכת. פרט ריק לא מופיע גם כשהוא מסומן.</p>
        {CARD_FIELDS.map((field) => (
          <Checkbox key={field.key} name="public_fields" value={field.key} label={field.label} defaultChecked={shown.has(field.key)} />
        ))}
      </fieldset>
      <Checkbox name="is_active" label="הכרטיס פעיל" hint={'כשהכרטיס כבוי, הקישור והקוד מציגים "הכרטיס לא נמצא".'} defaultChecked={card ? card.isActive : true} />
      <SubmitButton>{card ? "שמירת הכרטיס" : "יצירת הכרטיס"}</SubmitButton>
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
    </form>
  );
}
