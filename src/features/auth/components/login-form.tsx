"use client";

import Link from "next/link";
import { useActionState } from "react";

import { FormError } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { signInAction } from "../actions";
import { GOOGLE_ENABLED, GoogleButton } from "./google-button";

export function LoginForm({ next, initialError }: { next: string; initialError?: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(signInAction, null);
  const failure = state && !state.ok ? state : null;

  return (
    <div className="space-y-4">
      {GOOGLE_ENABLED ? (
        <>
          <GoogleButton next={next} />
          <p className="text-center text-sm text-ink-soft">או עם אימייל וסיסמה</p>
        </>
      ) : null}
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
        <p className="text-sm">
          <Link href={paths.forgotPassword} className="text-accent underline underline-offset-4 hover:text-accent-strong">
            שכחתי סיסמה
          </Link>
        </p>
        <SubmitButton pendingText="מתחבר…" className="w-full">
          כניסה
        </SubmitButton>
      </form>
    </div>
  );
}
