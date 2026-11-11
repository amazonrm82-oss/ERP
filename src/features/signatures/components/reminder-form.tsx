"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { SIGNATURE_REMINDER_CHOICES, SIGNATURE_REMINDERS_MAX, signatureReminderLabel, type SignatureReminderSettings } from "../reminder";
import { saveSignatureReminderAction } from "../reminder-actions";

type Props = { orgId: string; settings: SignatureReminderSettings };

/** SGN-03: reminders about a document not signed yet: a task for the sender, and one message to the customer. Owners and admins. */
export function SignatureReminderForm({ orgId, settings }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveSignatureReminderAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const picked = failure?.values?.signature_reminder_days ?? String(settings.days);
  const customer = failure?.values ? failure.values.signature_customer_reminder === "on" : settings.customer;
  const choices = SIGNATURE_REMINDER_CHOICES.includes(settings.days)
    ? SIGNATURE_REMINDER_CHOICES
    : [...SIGNATURE_REMINDER_CHOICES, settings.days].sort((a, b) => a - b);

  return (
    <form action={formAction} noValidate className="space-y-3">
      <SelectField
        key={picked}
        label="תזכורת לנציג על מסמך שלא נחתם"
        name="signature_reminder_days"
        defaultValue={picked}
        hint={`משימה למי ששלח את המסמך, להזכיר ללקוח לחתום, בימי העבודה של העסק: עד ${SIGNATURE_REMINDERS_MAX} פעמים לכל מסמך. משימה שעוד פתוחה עוברת לתאריך החדש. המשימה נסגרת מעצמה כשהמסמך נחתם, בוטל או פג תוקפו.`}
        error={failure?.fieldErrors?.signature_reminder_days}
      >
        {choices.map((value) => (
          <option key={value} value={value}>
            {signatureReminderLabel(value)}
          </option>
        ))}
      </SelectField>
      <Checkbox
        key={String(customer)}
        name="signature_customer_reminder"
        label="תזכורת ללקוח יומיים לפני שהתוקף נגמר"
        hint="הודעה אחת ב-SMS או באימייל, רק למסמך עם תאריך תוקף. ההודעות ללקוחות יישלחו כשיחובר ספק הודעות."
        defaultChecked={customer}
      />
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SubmitButton>שמירה</SubmitButton>
    </form>
  );
}
