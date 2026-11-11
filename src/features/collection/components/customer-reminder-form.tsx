"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { COLLECTION_STAGE_LABELS, COLLECTION_TASK_ALWAYS_STAGE, type CollectionCustomerReminderSettings } from "../customer-reminder";
import { saveCollectionCustomerReminderAction } from "../customer-reminder-actions";
import { COLLECTION_REMINDER_OFFSETS } from "../reminders";

type Props = { orgId: string; settings: CollectionCustomerReminderSettings; sms: boolean };

/** COL-07: whether the collection reminders also go to the customer, and at which stages. Owners and admins. */
export function CollectionCustomerReminderForm({ orgId, settings, sms }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveCollectionCustomerReminderAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const checked = failure?.values ? failure.values.collection_customer_reminder === "on" : settings.on;
  const stageKey = settings.stages.join(",");

  return (
    <form action={formAction} noValidate className="space-y-3">
      <Checkbox
        key={String(checked)}
        name="collection_customer_reminder"
        label="לשלוח את תזכורות הגבייה גם ללקוח"
        hint={`בכל שלב שנבחר למטה תצא הודעה אחת ללקוח, בערוץ המועדף עליו אם הוא ${sms ? "SMS או אימייל" : "אימייל"}, אחרת ${
          sms ? "ב-SMS לטלפון שלו, ואם אין טלפון באימייל" : "באימייל"
        }. מסמך ששולם, בוטל או שיש עליו הבטחת תשלום לא מקבל הודעה, והודעה שעוד ממתינה מתבטלת כשהחוב נסגר. ההודעות יישלחו כשיחובר ספק הודעות.`}
        defaultChecked={checked}
      />
      <fieldset className="space-y-2" key={stageKey}>
        <legend className="text-sm font-medium">מתי לשלוח ללקוח</legend>
        {COLLECTION_REMINDER_OFFSETS.map((offset) => (
          <Checkbox
            key={offset}
            name="collection_customer_stages"
            value={String(offset)}
            label={COLLECTION_STAGE_LABELS[offset]}
            defaultChecked={settings.stages.includes(offset)}
          />
        ))}
        <p className="text-sm text-ink-soft">
          {`משימה לנציג נוצרת רק בשלב שבו לא יצאה הודעה ללקוח, ותמיד בשלב של ${COLLECTION_STAGE_LABELS[COLLECTION_TASK_ALWAYS_STAGE]}.`}
        </p>
      </fieldset>
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SubmitButton>שמירה</SubmitButton>
    </form>
  );
}
