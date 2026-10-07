"use client";

import Link from "next/link";
import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { signUpAction } from "../actions";
import { GOOGLE_ENABLED, GoogleButton } from "./google-button";
import { PASSWORD_MIN } from "../schema";

export function SignupForm({ next }: { next: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(signUpAction, null);
  const failure = state && !state.ok ? state : null;

  if (state?.ok) {
    // waiting for the user to confirm their email address
    return <FormNotice message={state.message} />;
  }

  return (
    <>
      {GOOGLE_ENABLED ? (
        <div className="mb-4 space-y-4">
          <GoogleButton next={next} />
          <p className="text-center text-sm text-ink-soft">או עם אימייל וסיסמה</p>
        </div>
      ) : null}
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
      <p className="mt-4 text-sm text-ink-soft">
        לפני הכניסה הראשונה תתבקשו לחתום על <TermsLink slug="terms">תנאי השימוש</TermsLink>, <TermsLink slug="privacy">מדיניות הפרטיות</TermsLink> ו
        <TermsLink slug="dpa">הסכם עיבוד המידע</TermsLink>.
      </p>
    </>
  );
}

// opens in a new tab, so a half-filled form is not lost
function TermsLink({ slug, children }: { slug: string; children: string }) {
  return (
    <Link href={paths.legal(slug)} target="_blank" rel="noopener" className="text-accent-strong underline underline-offset-4">
      {children}
    </Link>
  );
}
