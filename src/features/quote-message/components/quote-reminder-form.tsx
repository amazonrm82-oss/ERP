"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveQuoteReminderAction } from "../reminder-actions";

type Props = { orgId: string; on: boolean };

/** QUO-18 (381)-(383): the automatic reminders to a customer about a quote. Owners and admins; off until switched on. */
export function QuoteReminderForm({ orgId, on }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveQuoteReminderAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const checked = failure?.values ? failure.values.quote_customer_reminder === "on" : on;
  return (
    <form action={formAction} noValidate className="space-y-3">
      <Checkbox
        key={String(checked)}
        name="quote_customer_reminder"
        label="תזכורות אוטומטיות ללקוח על הצעת מחיר"
        hint="ללקוח שלא פתח את ההצעה: עד שתי תזכורות, 3 ו-7 ימי עבודה אחרי השליחה. ללקוח שפתח ולא ענה: תזכורת אחת יומיים לפני שהתוקף נגמר. אף פעם לא אחרי התוקף, ולא אחרי שהלקוח אישר או דחה. ההודעות ללקוחות יישלחו כשיחובר ספק הודעות."
        defaultChecked={checked}
      />
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SubmitButton>שמירה</SubmitButton>
    </form>
  );
}
