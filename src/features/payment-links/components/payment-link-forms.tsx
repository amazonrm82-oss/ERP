"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";

import { cancelPaymentLinkAction, createPaymentLinkAction } from "../actions";
import { PAYMENT_LINK_DAYS_MAX, PAYMENT_LINK_INSTALLMENTS_MAX, type PaymentLinkSource } from "../schema";

// LNK-02: "קישור תשלום" and its form (amount, maximum instalments, last day), and cancelling a pending link.

export function CreatePaymentLinkButton({
  orgId,
  source,
  defaultAmount,
  defaultLastDay,
  today,
  lastDayMax,
  amountHint,
}: {
  orgId: string;
  source: PaymentLinkSource;
  // "1,170.00" or "": the amount the form starts with (what is open)
  defaultAmount: string;
  defaultLastDay: string;
  today: string;
  lastDayMax: string;
  amountHint: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <PlusIcon />
        קישור תשלום
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="קישור תשלום חדש"
        description="הלקוח משלם בדף של ספק הסליקה. פרטי הכרטיס לא עוברים דרכנו ולא נשמרים אצלנו."
        variant="sheet"
      >
        {open ? (
          <CreateForm
            orgId={orgId}
            source={source}
            defaultAmount={defaultAmount}
            defaultLastDay={defaultLastDay}
            today={today}
            lastDayMax={lastDayMax}
            amountHint={amountHint}
            onDone={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        ) : null}
      </Dialog>
    </>
  );
}

function CreateForm({
  orgId,
  source,
  defaultAmount,
  defaultLastDay,
  today,
  lastDayMax,
  amountHint,
  onDone,
  onCancel,
}: {
  orgId: string;
  source: PaymentLinkSource;
  defaultAmount: string;
  defaultLastDay: string;
  today: string;
  lastDayMax: string;
  amountHint: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const action = createPaymentLinkAction.bind(null, orgId, source);
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) onDone();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextField
        label="סכום לתשלום (₪)"
        name="amount"
        required
        dir="ltr"
        inputMode="decimal"
        defaultValue={values?.amount ?? defaultAmount}
        hint={amountHint}
        error={errors.amount}
      />
      <TextField
        label="מספר תשלומים מרבי בכרטיס"
        name="max_installments"
        dir="ltr"
        inputMode="numeric"
        defaultValue={values?.max_installments ?? "1"}
        hint={`בין 1 ל-${PAYMENT_LINK_INSTALLMENTS_MAX}. הלקוח בוחר עד המספר הזה.`}
        error={errors.max_installments}
      />
      <DateField
        label="יום אחרון לתשלום"
        name="expires_on"
        required
        defaultValue={values?.expires_on ?? defaultLastDay}
        min={today}
        max={lastDayMax}
        hint={`עד ${PAYMENT_LINK_DAYS_MAX} יום קדימה. בסוף היום הזה הקישור מפסיק לעבוד.`}
        error={errors.expires_on}
      />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="יוצרים…">יצירת הקישור</SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

export function CancelPaymentLinkButton({ orgId, source, linkId, label }: { orgId: string; source: PaymentLinkSource; linkId: string; label: string }) {
  return (
    <ConfirmButton
      title={`לבטל את קישור התשלום ${label}?`}
      description="הקישור יפסיק לעבוד מיד. הוא לא נמחק: הוא נשאר ברשימה, מסומן כמבוטל."
      confirmLabel="ביטול הקישור"
      action={cancelPaymentLinkAction.bind(null, orgId, source, linkId)}
    >
      ביטול
    </ConfirmButton>
  );
}
