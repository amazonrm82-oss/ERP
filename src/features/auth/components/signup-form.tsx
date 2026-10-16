"use client";

import Link from "next/link";
import { useActionState, useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { resendConfirmationAction, signUpAction } from "../actions";
import { GOOGLE_ENABLED, GoogleButton } from "./google-button";
import { PASSWORD_MIN } from "../schema";

export function SignupForm({ next }: { next: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(signUpAction, null);
  const failure = state && !state.ok ? state : null;
  // the address the confirmation went to, and whether the form is shown again to fix it (FXU-05)
  const [sentTo, setSentTo] = useState<{ email: string; name: string } | null>(null);
  const [editing, setEditing] = useState(false);

  if (state?.ok && sentTo && !editing) {
    return <WaitingForConfirmation email={sentTo.email} next={next} message={state.message ?? ""} onBack={() => setEditing(true)} />;
  }

  return (
    <>
      {GOOGLE_ENABLED ? (
        <div className="mb-4 space-y-4">
          <GoogleButton next={next} />
          <p className="text-center text-sm text-ink-soft">או עם אימייל וסיסמה</p>
        </div>
      ) : null}
      <form
        action={(formData) => {
          setSentTo({ email: String(formData.get("email") ?? ""), name: String(formData.get("full_name") ?? "") });
          setEditing(false);
          formAction(formData);
        }}
        className="space-y-4"
        noValidate
      >
        <input type="hidden" name="next" value={next} />
        <FormError message={failure?.message} />
        <TextField
          label="שם מלא"
          name="full_name"
          autoComplete="name"
          required
          defaultValue={failure?.values?.full_name ?? (editing ? sentTo?.name : undefined)}
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
          defaultValue={failure?.values?.email ?? (editing ? sentTo?.email : undefined)}
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
        <SubmitButton pendingText="יוצרים חשבון…" className="w-full">
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

const RESEND_WAIT_SECONDS = 60;

/** After sign-up: the email is on its way; send it again, or go back and fix the address (FXU-05). */
function WaitingForConfirmation({ email, next, message, onBack }: { email: string; next: string; message: string; onBack: () => void }) {
  const [wait, setWait] = useState(RESEND_WAIT_SECONDS);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  function resend() {
    setResult(null);
    startTransition(async () => {
      const reply = await resendConfirmationAction(email, next);
      setResult(reply.ok ? { ok: true, text: "שלחנו שוב. בדקו גם בתיקיית הספאם." } : { ok: false, text: reply.message });
      setWait(RESEND_WAIT_SECONDS);
    });
  }

  return (
    <div className="space-y-4">
      <FormNotice message={message} />
      <p className="text-md text-ink-soft">ההודעה לא הגיעה? כדאי לבדוק בתיקיית הספאם, או לשלוח שוב.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={resend} loading={pending} disabled={wait > 0}>
          {wait > 0 ? `שליחה חוזרת (בעוד ${wait})` : "שליחה חוזרת"}
        </Button>
        <Button variant="ghost" onClick={onBack}>
          חזרה לטופס, לתיקון הכתובת
        </Button>
      </div>
      {result ? result.ok ? <FormNotice message={result.text} /> : <FormError message={result.text} /> : null}
    </div>
  );
}

// opens in a new tab, so a half-filled form is not lost
function TermsLink({ slug, children }: { slug: string; children: string }) {
  return (
    <Link href={paths.legal(slug)} target="_blank" rel="noopener" className="text-accent-strong underline underline-offset-4">
      {children}
      <span className="sr-only"> (נפתח בחלון חדש)</span>
    </Link>
  );
}
