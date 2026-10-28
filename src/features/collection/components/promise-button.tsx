"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";

import {
  removePromiseAction,
  savePromiseAction,
  type PromiseBack,
  type PromiseTarget,
} from "../actions";
import { lastPromiseDay, PROMISE_NOTE_MAX } from "../promise";

type Current = { date: string; note: string | null } | null;

/** COL-03: records, changes or removes the payment promise of one open document, or of the whole customer. */
export function PromiseButton({
  orgId,
  target,
  label,
  back,
  current,
  today,
}: {
  orgId: string;
  target: PromiseTarget;
  label: string;
  back: PromiseBack;
  current: Current;
  today: string;
}) {
  const [open, setOpen] = useState(false);
  const customer = target.kind !== "document";
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`${customer ? "הבטחת תשלום ללקוח" : "הבטחת תשלום"}: ${label}`}
      >
        {customer
          ? current
            ? "שינוי ההבטחה ללקוח"
            : "הבטחת תשלום ללקוח"
          : current
            ? "שינוי הבטחה"
            : "הבטחת תשלום"}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`הבטחת תשלום: ${label}`}
        variant="sheet"
      >
        {open ? (
          <PromiseForm
            orgId={orgId}
            target={target}
            back={back}
            current={current}
            today={today}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </Dialog>
    </>
  );
}

function PromiseForm({
  orgId,
  target,
  back,
  current,
  today,
  onDone,
}: {
  orgId: string;
  target: PromiseTarget;
  back: PromiseBack;
  current: Current;
  today: string;
  onDone: () => void;
}) {
  const action = savePromiseAction.bind(null, orgId, target, back);
  const [state, formAction] = useActionState<FormState, FormData>(
    async (prev, formData) => {
      const result = await action(prev, formData);
      if (result?.ok) onDone();
      return result;
    },
    null,
  );
  const failure = state && !state.ok ? state : null;
  // a passed promise is offered today's date to change it (the database refuses a new date in the past)
  const start = current && current.date >= today ? current.date : "";
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError
        message={failure && !failure.fieldErrors ? failure.message : null}
      />
      <p className="text-sm text-ink-soft">
        {target.kind === "document"
          ? "התאריך שהלקוח התחייב לשלם בו. עד אז לא נשלחות לו תזכורות גבייה על המסמך הזה."
          : "התאריך שהלקוח התחייב לשלם בו את החובות הפתוחים שלו. ההבטחה חלה על המסמכים הפתוחים עכשיו, לא על מסמכים שיירשמו אחר כך."}
      </p>
      <DateField
        label="הלקוח התחייב לשלם עד"
        name="promised_date"
        required
        min={today}
        max={lastPromiseDay(today)}
        defaultValue={failure?.values?.promised_date ?? start}
        error={failure?.fieldErrors?.promised_date}
      />
      <TextareaField
        label="הערת גבייה (רשות)"
        name="note"
        rows={3}
        maxLength={PROMISE_NOTE_MAX}
        defaultValue={failure?.values?.note ?? current?.note ?? ""}
        hint="למשל: עם מי דיברתם ומה סוכם."
        error={failure?.fieldErrors?.note}
      />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="שומרים…">שמירה</SubmitButton>
        <Button variant="ghost" onClick={onDone}>
          חזרה
        </Button>
        {current ? (
          <ConfirmButton
            title="להסיר את הבטחת התשלום?"
            description={
              target.kind === "document"
                ? "התזכורות על המסמך יחזרו לפי מועד התשלום שלו."
                : "התזכורות על המסמכים יחזרו לפי מועדי התשלום שלהם."
            }
            confirmLabel="הסרה"
            action={removePromiseAction.bind(null, orgId, target, back)}
            onDone={onDone}
          >
            הסרת ההבטחה
          </ConfirmButton>
        ) : null}
      </div>
    </form>
  );
}
