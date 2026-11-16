"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { magicLinkAction } from "../actions";
import { TURNSTILE_ACTIONS } from "../turnstile";
import { TurnstileWidget } from "./turnstile-widget";

// USR-10 (owner (389) ג): a secondary way in on /login, a one-time link to the email. Closed until asked for; while it is open
// LoginForm hides the password form (and its Turnstile widget), so the page shows one widget at a time. `next` (an invitation,
// a page the person was sent from) travels with the link.
type Props = { next: string; turnstileSiteKey?: string | null; open: boolean; onOpenChange: (open: boolean) => void };

export function MagicLinkForm({ next, turnstileSiteKey, open, onOpenChange }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(magicLinkAction, null);
  const failure = state && !state.ok ? state : null;

  if (!open) {
    return (
      <Button variant="secondary" className="w-full" onClick={() => onOpenChange(true)} aria-expanded={false}>
        כניסה בקישור למייל
      </Button>
    );
  }
  const back = (
    <Button variant="ghost" className="w-full" onClick={() => onOpenChange(false)}>
      חזרה לכניסה עם סיסמה
    </Button>
  );
  if (state?.ok) {
    return (
      <div className="space-y-3">
        <FormNotice message={state.message} />
        {back}
      </div>
    );
  }
  return (
    <section aria-labelledby="magic-link-title" className="space-y-3 rounded-lg border border-line p-4">
      <h2 id="magic-link-title" className="text-md font-semibold">
        כניסה בקישור למייל
      </h2>
      <p className="text-sm text-ink-soft">נשלח לכם קישור כניסה חד-פעמי. אחרי הלחיצה עליו נבקש גם את קוד האימות הדו-שלבי, אם הוא מופעל בחשבון.</p>
      <form action={formAction} className="space-y-4" noValidate>
        <input type="hidden" name="next" value={next} />
        <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
        <TextField
          label="אימייל לקבלת הקישור"
          name="email"
          autoFocus
          type="email"
          dir="ltr"
          autoComplete="email"
          inputMode="email"
          required
          defaultValue={failure?.values?.email}
          error={failure?.fieldErrors?.email}
        />
        {turnstileSiteKey ? <TurnstileWidget siteKey={turnstileSiteKey} action={TURNSTILE_ACTIONS.magicLink} resetSignal={state} /> : null}
        <SubmitButton pendingText="שולחים…" variant="secondary" className="w-full">
          שליחת קישור כניסה
        </SubmitButton>
      </form>
      {back}
    </section>
  );
}
