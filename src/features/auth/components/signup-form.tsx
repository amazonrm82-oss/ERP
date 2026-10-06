"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { signUpAction } from "../actions";
import { PASSWORD_MIN } from "../schema";

export function SignupForm({ next }: { next: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(signUpAction, null);
  const failure = state && !state.ok ? state : null;

  if (state?.ok) {
    // waiting for the user to confirm their email address
    return <FormNotice message={state.message} />;
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="next" value={next} />
      <FormError message={failure?.message} />
      <TextField
        label="שם מלא"
        name="full_name"
        autoComplete="name"
        required
        defaultValue={failure?.values?.full_name}
        error={failure?.fieldErrors?.full_name}
      />
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
      <TextField
        label="סיסמה"
        name="password"
        type="password"
        dir="ltr"
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN}
        hint={`לפחות ${PASSWORD_MIN} תווים.`}
        error={failure?.fieldErrors?.password}
      />
      <SubmitButton pendingText="יוצר חשבון…" className="w-full">
        יצירת חשבון
      </SubmitButton>
    </form>
  );
}
