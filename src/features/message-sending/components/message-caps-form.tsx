"use client";

import { useActionState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveMessageCapsAction } from "../actions";
import type { MessageCaps } from "../queries";
import { CAP_FIELDS, CHANNEL_LABELS, MESSAGE_CHANNELS } from "../usage";

type Props = { orgId: string; caps: MessageCaps };

/** MSG-05: the business's monthly cap of marketing messages per channel. Owners and admins of a writable business. */
export function MessageCapsForm({ orgId, caps }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveMessageCapsAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};

  return (
    <form action={formAction} noValidate>
      <Card aria-labelledby="message-caps-title">
        <CardHeader id="message-caps-title" title="תקרה חודשית להודעות שיווק" />
        <CardBody className="space-y-5">
          <p className="text-sm text-ink-soft">
            התקרה חלה רק על הודעות שיווק. הודעות שירות (תזכורת לפגישה, גבייה, מסמך שהלקוח ביקש, קוד אימות) לא מוגבלות בתקרה, אבל כן מחכות לשעות השליחה (חוץ מקוד אימות). הודעת שיווק מעל
            התקרה לא מבוטלת: היא מחכה עד שהתקרה תוגדל, גם כשמתחיל חודש חדש, ואפשר לבטל אותה בכרטיס השימוש. שדה ריק: בלי תקרה של העסק.
          </p>
          <div className="flex flex-wrap gap-4">
            {MESSAGE_CHANNELS.map((channel) => {
              const field = CAP_FIELDS[channel];
              const value = caps[channel];
              return (
                <TextField
                  key={channel}
                  label={CHANNEL_LABELS[channel]}
                  name={field}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={10_000_000}
                  step={1}
                  dir="ltr"
                  className="w-40"
                  defaultValue={failure?.values?.[field] ?? (value === null ? "" : String(value))}
                  error={errors[field]}
                />
              );
            })}
          </div>
          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton>שמירה</SubmitButton>
        </CardBody>
      </Card>
    </form>
  );
}
