"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { pauseSendingAction, resumeSendingAction } from "../actions";
import { PAUSE_REASON_MAX } from "../pause";

/** HEB-09: one button stops all automatic sending to customers; the reason is required and shows in the banner. */
export function PauseSendingForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(pauseSendingAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextareaField
        label="סיבה"
        name="reason"
        required
        rows={2}
        maxLength={PAUSE_REASON_MAX}
        placeholder="למשל: יום אבל לאומי"
        hint="הסיבה מופיעה לכל הצוות בפס שבראש המסך."
        defaultValue={failure?.values?.reason}
        error={failure?.fieldErrors?.reason}
      />
      <SubmitButton variant="danger" pendingText="עוצרים…">
        עצירת כל השליחה ללקוחות
      </SubmitButton>
    </form>
  );
}

/** HEB-09: resumes sending; nothing that waited is sent afterwards on its own. */
export function ResumeSendingForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(resumeSendingAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-3">
      <FormError message={failure?.message ?? null} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SubmitButton pendingText="מחדשים…">חידוש השליחה</SubmitButton>
    </form>
  );
}
