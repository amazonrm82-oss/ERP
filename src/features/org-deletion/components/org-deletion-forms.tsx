"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { cancelOrgDeletionAction, confirmOrgDeletionAction, requestOrgDeletionAction } from "../actions";

/** ADM-03: the owner types the business's name and asks; Supabase Auth emails the owner a code. */
export function RequestOrgDeletionForm({ orgId, businessName }: { orgId: string; businessName: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(requestOrgDeletionAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
      <TextField
        label="הקלידו את שם העסק לאישור"
        name="name"
        required
        autoComplete="off"
        maxLength={200}
        hint={`השם: ${businessName}`}
        defaultValue={failure?.values?.name}
        error={failure?.fieldErrors?.name}
      />
      <SubmitButton variant="danger" pendingText="שולחים…">
        שליחת קוד אישור לאימייל
      </SubmitButton>
    </form>
  );
}

/** ADM-03: cancels the pending deletion, or the request that waits for the emailed link. */
export function CancelOrgDeletionForm({ orgId, label }: { orgId: string; label: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(cancelOrgDeletionAction.bind(null, orgId), null);
  return (
    <form action={formAction} className="space-y-3">
      <FormError message={state && !state.ok ? state.message : null} />
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
      {state?.ok ? null : <SubmitButton pendingText="מבטלים…">{label}</SubmitButton>}
    </form>
  );
}

/** ADM-03: the code Supabase Auth emailed to the owner; the database checks it. */
export function ConfirmOrgDeletionForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(confirmOrgDeletionAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  if (state?.ok) return <FormNotice message={state.message ?? null} />;
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextField
        label="הקוד מהאימייל"
        name="code"
        required
        inputMode="numeric"
        autoComplete="one-time-code"
        dir="ltr"
        maxLength={10}
        defaultValue={failure?.values?.code}
        error={failure?.fieldErrors?.code}
      />
      <SubmitButton variant="danger" pendingText="מאשרים…">
        אישור מחיקת העסק
      </SubmitButton>
    </form>
  );
}
