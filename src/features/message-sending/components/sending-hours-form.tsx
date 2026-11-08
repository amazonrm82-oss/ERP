"use client";

import { useActionState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveSendingHoursAction } from "../actions";
import { SHORT_DAY_UNTIL, untilInputValue, type SendingHours } from "../hours";

type Props = { orgId: string; hours: SendingHours };

/** MSG-06: the hours in which messages go out to customers. Owners and admins of a writable business. */
export function SendingHoursForm({ orgId, hours }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveSendingHoursAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const skipDefault = failure?.values ? failure.values.skip_rest_days === "on" : hours.skipRestDays;

  return (
    <form action={formAction} noValidate>
      <Card aria-labelledby="sending-hours-title">
        <CardHeader id="sending-hours-title" title="שעות שליחה" />
        <CardBody className="space-y-5">
          <div className="flex flex-wrap gap-4">
            <TextField
              label="מהשעה"
              name="window_from"
              type="time"
              step={60}
              dir="ltr"
              className="w-36"
              defaultValue={failure?.values?.window_from ?? hours.from}
              error={errors.window_from}
            />
            <TextField
              label="עד השעה"
              name="window_until"
              type="time"
              step={60}
              dir="ltr"
              className="w-36"
              hint="00:00 = עד חצות."
              defaultValue={failure?.values?.window_until ?? untilInputValue(hours.until)}
              error={errors.window_until}
            />
          </div>
          <Checkbox
            name="skip_rest_days"
            label="לא לשלוח בימי מנוחה ובחגים של העסק"
            hint={`ביום עבודה מקוצר (שישי או ערב חג לפני יום מנוחה) השליחה נגמרת ב-${SHORT_DAY_UNTIL}. ימי המנוחה נקבעים בהגדרות לוח השנה.`}
            defaultChecked={skipDefault}
          />
          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton>שמירה</SubmitButton>
        </CardBody>
      </Card>
    </form>
  );
}
