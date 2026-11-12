"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { forgotPasswordAction } from "../actions";
import { TURNSTILE_ACTIONS } from "../turnstile";
import { TurnstileWidget } from "./turnstile-widget";

export function ForgotPasswordForm({ turnstileSiteKey }: { turnstileSiteKey?: string | null }) {
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
      {turnstileSiteKey ? <TurnstileWidget siteKey={turnstileSiteKey} action={TURNSTILE_ACTIONS.forgotPassword} resetSignal={state} /> : null}
      <SubmitButton pendingText="שולחים…" className="w-full">
        שליחת קישור
      </SubmitButton>
    </form>
  );
}
