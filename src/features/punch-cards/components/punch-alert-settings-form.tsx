"use client";

import { useActionState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { savePunchAlertSettingsAction } from "../alert-actions";
import { PUNCH_EXPIRY_DAYS_MAX, PUNCH_LOW_ENTRIES_MAX } from "../alerts";

type Props = { orgId: string; lowEntries: number; expiryDays: number; customerMessages: boolean };

/** PKG-03: when a punch card alerts its rep. Owners and admins of a writable business. */
export function PunchAlertSettingsForm({ orgId, lowEntries, expiryDays, customerMessages }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(savePunchAlertSettingsAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};

  return (
    <form action={formAction} noValidate>
      <Card aria-labelledby="punch-alerts-title">
        <CardHeader id="punch-alerts-title" title="התראות כרטיסייה" />
        <CardBody className="space-y-5">
          <TextField
            label="התראה כשנשארו (כניסות או פחות)"
            name="low_entries"
            type="number"
            inputMode="numeric"
            min={0}
            max={PUNCH_LOW_ENTRIES_MAX}
            step={1}
            dir="ltr"
            className="max-w-40"
            hint={`בין 0 ל-${PUNCH_LOW_ENTRIES_MAX}. 0 מכבה את ההתראה.`}
            defaultValue={failure?.values?.low_entries ?? String(lowEntries)}
            error={errors.low_entries}
          />
          <TextField
            label="התראה לפני סוף התוקף (ימים)"
            name="expiry_days"
            type="number"
            inputMode="numeric"
            min={0}
            max={PUNCH_EXPIRY_DAYS_MAX}
            step={1}
            dir="ltr"
            className="max-w-40"
            hint={`בין 0 ל-${PUNCH_EXPIRY_DAYS_MAX}. 0 מכבה את ההתראה.`}
            defaultValue={failure?.values?.expiry_days ?? String(expiryDays)}
            error={errors.expiry_days}
          />
          <Checkbox
            name="customer_messages"
            label="לשלוח גם ללקוח הודעה"
            defaultChecked={failure?.values ? failure.values.customer_messages === "on" : customerMessages}
            hint={'הודעת שירות מהתבניות "כרטיסייה: נשארו מעט כניסות" ו"כרטיסייה: התוקף מתקרב": בערוץ המועדף של איש הקשר, ואם אין, ב-SMS, ב-WhatsApp או באימייל.'}
          />
          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton>שמירה</SubmitButton>
        </CardBody>
      </Card>
    </form>
  );
}
