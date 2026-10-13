"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { recordConsentAction } from "../actions";
import {
  CHANNEL_LABELS,
  LIFT_METHOD_LABELS,
  LIFT_METHODS,
  LIFT_NOTE_MAX,
  MANUAL_STATES,
  METHOD_MAX,
  STATE_LABELS,
  WORDING_MAX,
  type ConsentChannel,
} from "../model";
import type { ConsentSubject } from "../queries";

// canLift: an owner or admin, who may lift an opt-out with its source (the database decides)
type Props = { orgId: string; subject: ConsentSubject; channels: ConsentChannel[]; canLift: boolean };

/** CNS-03: "רישום הסכמה" opens a short form: channel, state, how it was given (required), wording. */
export function RecordConsentButton({ orgId, subject, channels, canLift }: Props) {
  const [open, setOpen] = useState(false);
  // a new form each time the window opens
  const [round, setRound] = useState(0);
  if (channels.length === 0) {
    return null;
  }
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          setRound((n) => n + 1);
          setOpen(true);
        }}
      >
        רישום הסכמה
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="רישום הסכמה לדיוור" description="כל רישום נשמר בהיסטוריה ולא ניתן לשינוי." variant="sheet">
        {open ? <ConsentForm key={round} orgId={orgId} subject={subject} channels={channels} canLift={canLift} onDone={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

function ConsentForm({ orgId, subject, channels, canLift, onDone }: Props & { onDone: () => void }) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await recordConsentAction(orgId, subject, prev, formData);
    if (result?.ok) {
      onDone();
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors;
  const values = failure?.values;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={errors ? undefined : failure?.message} />
      <SelectField label="ערוץ" name="channel" required defaultValue={values?.channel ?? channels[0]} error={errors?.channel}>
        {channels.map((channel) => (
          <option key={channel} value={channel}>
            {CHANNEL_LABELS[channel]}
          </option>
        ))}
      </SelectField>
      <SelectField label="מצב" name="state" required defaultValue={values?.state ?? "granted"} error={errors?.state}>
        {MANUAL_STATES.map((value) => (
          <option key={value} value={value}>
            {STATE_LABELS[value]}
          </option>
        ))}
      </SelectField>
      <TextField
        label="איך התקבלה ההסכמה"
        name="method"
        required
        maxLength={METHOD_MAX}
        placeholder="למשל: אמר בשיחה טלפונית שהוא מסכים"
        defaultValue={values?.method}
        error={errors?.method}
      />
      <TextareaField
        label="נוסח ההסכמה"
        name="wording"
        hint="לא חובה. הנוסח שהלקוח הסכים לו, אם היה."
        maxLength={WORDING_MAX}
        defaultValue={values?.wording}
        error={errors?.wording}
      />
      {canLift ? (
        <fieldset className="space-y-3 rounded-md border border-line p-3">
          <legend className="px-1 text-sm font-medium">ביטול הסרה מדיוור (בעלים ומנהלי מערכת)</legend>
          <p className="text-sm text-ink-soft">
            רק כשהאדם ביקש שוב לקבל דיוור. אחרי מחיקה לבקשת האדם רק הסכמה שלו בטופס מבטלת. הנוסח זמני עד אישור עורך דין.
          </p>
          <SelectField label="איך האדם ביקש שוב" name="lift_method" defaultValue={values?.lift_method ?? ""} error={errors?.lift_method}>
            <option value="">לא, זו לא ביטול הסרה</option>
            {LIFT_METHODS.map((value) => (
              <option key={value} value={value}>
                {LIFT_METHOD_LABELS[value]}
              </option>
            ))}
          </SelectField>
          <TextField label="הערה קצרה" name="lift_note" maxLength={LIFT_NOTE_MAX} defaultValue={values?.lift_note} error={errors?.lift_note} />
        </fieldset>
      ) : null}
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="שומרים…">שמירה</SubmitButton>
        <Button variant="ghost" onClick={onDone}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
