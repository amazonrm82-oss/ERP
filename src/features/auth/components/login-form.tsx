"use client";

import { useActionState } from "react";

import { FormError } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { signInAction } from "../actions";

export function LoginForm({ next, initialError }: { next: string; initialError?: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(signInAction, null);
  const failure = state && !state.ok ? state : null;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="next" value={next} />
      <FormError message={failure?.message ?? initialError} />
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
        autoComplete="current-password"
        required
        error={failure?.fieldErrors?.password}
      />
      <SubmitButton pendingText="מתחבר…" className="w-full">
        כניסה
      </SubmitButton>
    </form>
  );
}
