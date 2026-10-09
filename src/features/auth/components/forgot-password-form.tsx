"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { forgotPasswordAction } from "../actions";

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState<FormState, FormData>(forgotPasswordAction, null);
  const failure = state && !state.ok ? state : null;
  if (state?.ok) {
    return <FormNotice message={state.message} />;
  }
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextField
        label="אימייל"
        name="email"
        type="email"
        dir="ltr"
        autoComplete="email"
        inputMode="email"
        required
        defaultValue={failure?.values?.email}
        error={failure?.fieldErrors?.email}
      />
      <SubmitButton pendingText="שולחים…" className="w-full">
        שליחת קישור
      </SubmitButton>
    </form>
  );
}
