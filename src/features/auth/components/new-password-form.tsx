"use client";

import Link from "next/link";
import { useActionState } from "react";

import { buttonClasses } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { setPasswordAction } from "../actions";
import { PASSWORD_MIN } from "../schema";

/** New password and its confirmation. `continueHref`: where to go after saving (the reset flow). */
export function NewPasswordForm({ continueHref }: { continueHref?: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(setPasswordAction, null);
  const failure = state && !state.ok ? state : null;
  if (state?.ok && continueHref) {
    return (
      <div className="space-y-4">
        <FormNotice message={state.message} />
        <Link href={continueHref} className={buttonClasses("primary", "md", "w-full")}>
          המשך למערכת
        </Link>
      </div>
    );
  }
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <FormNotice message={state?.ok ? state.message : null} />
      <TextField
        label="סיסמה חדשה"
        name="password"
        type="password"
        dir="ltr"
        autoComplete="new-password"
        minLength={PASSWORD_MIN}
        hint={`לפחות ${PASSWORD_MIN} תווים.`}
        required
        error={failure?.fieldErrors?.password}
      />
      <TextField label="הסיסמה שוב" name="confirm" type="password" dir="ltr" autoComplete="new-password" required error={failure?.fieldErrors?.confirm} />
      <SubmitButton>שמירת הסיסמה</SubmitButton>
    </form>
  );
}
