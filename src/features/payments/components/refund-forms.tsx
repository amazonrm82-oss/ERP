"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";
import { formatMoney } from "@/lib/format";

import { cancelRefundAction, recordRefundAction } from "../actions";
import type { MoneySubject } from "../money-subject";
import { CANCEL_REASON_MAX, PAYMENT_METHOD_LABELS, PAYMENT_METHODS, PAYMENT_NOTE_MAX, PAYMENT_REFERENCE_MAX, type PaymentMethod } from "../schema";

// PAY-08: "החזר" on a payment (owners and admins) and cancelling a refund with a reason. A refund is never deleted.

export type RefundCreditDocument = { id: string; label: string };

/** "החזר" and its form: amount (up to what remains), date, how the money went back, and optionally a recorded credit invoice. */
export function RefundPaymentButton({
  orgId,
  subject,
  paymentId,
  label,
  method,
  remaining,
  today,
  creditDocuments,
}: {
  orgId: string;
  subject: MoneySubject;
  paymentId: string;
  label: string;
  method: PaymentMethod;
  remaining: number;
  today: string;
  creditDocuments: RefundCreditDocument[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`החזר מהתשלום: ${label}`}>
        החזר
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`החזר מהתשלום ${label}`}
        description={`אפשר להחזיר עד ${formatMoney(remaining)}. התשלום עצמו לא משתנה: ההחזר נרשם לידו ומפחית את מה שנספר ממנו.`}
        variant="sheet"
      >
        {open ? (
          <RefundForm
            orgId={orgId}
            subject={subject}
            paymentId={paymentId}
            method={method}
            today={today}
            creditDocuments={creditDocuments}
            onDone={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        ) : null}
      </Dialog>
    </>
  );
}

function RefundForm({
  orgId,
  subject,
  paymentId,
  method,
  today,
  creditDocuments,
  onDone,
  onCancel,
}: {
  orgId: string;
  subject: MoneySubject;
  paymentId: string;
  method: PaymentMethod;
  today: string;
  creditDocuments: RefundCreditDocument[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const action = recordRefundAction.bind(null, orgId, subject, paymentId);
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
        label="סכום ההחזר (₪)"
        name="amount"
        required
        dir="ltr"
        inputMode="decimal"
        defaultValue={values?.amount ?? ""}
        hint="החזר של כל הסכום מסמן את התשלום כ״הוחזר״. שיוכים למסמכים מעבר למה שנשאר משתחררים, מהחדש לישן."
        error={errors.amount}
      />
      <DateField label="תאריך ההחזר" name="refunded_on" required defaultValue={values?.refunded_on ?? today} error={errors.refunded_on} />
      <SelectField label="איך הוחזר הכסף" name="method" required defaultValue={values?.method ?? method} error={errors.method}>
        {PAYMENT_METHODS.map((m) => (
          <option key={m} value={m}>
            {PAYMENT_METHOD_LABELS[m]}
          </option>
        ))}
      </SelectField>
      <TextField label="אסמכתא" name="reference" dir="ltr" maxLength={PAYMENT_REFERENCE_MAX} defaultValue={values?.reference ?? ""} error={errors.reference} />
      {creditDocuments.length > 0 ? (
        <SelectField
          label="חשבונית זיכוי (רשות)"
          name="credit_document_id"
          defaultValue={values?.credit_document_id ?? ""}
          hint="חשבונית זיכוי שכבר נרשמה ללקוח הזה."
          error={errors.credit_document_id}
        >
          <option value="">בלי חשבונית זיכוי</option>
          {creditDocuments.map((doc) => (
            <option key={doc.id} value={doc.id}>
              {doc.label}
            </option>
          ))}
        </SelectField>
      ) : null}
      <TextareaField label="הערה" name="note" rows={2} maxLength={PAYMENT_NOTE_MAX} defaultValue={values?.note ?? ""} error={errors.note} />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="שומרים…">רישום ההחזר</SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

/** Cancelling a refund with a required reason (owners and admins); the refund stays on the list, marked cancelled. */
export function CancelRefundButton({ orgId, subject, refundId, label }: { orgId: string; subject: MoneySubject; refundId: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger-ghost" size="sm" onClick={() => setOpen(true)} aria-label={`ביטול ההחזר: ${label}`}>
        ביטול
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`לבטל את ההחזר ${label}?`} variant="sheet">
        {open ? <CancelRefundForm orgId={orgId} subject={subject} refundId={refundId} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

function CancelRefundForm({
  orgId,
  subject,
  refundId,
  onDone,
  onCancel,
}: {
  orgId: string;
  subject: MoneySubject;
  refundId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const action = cancelRefundAction.bind(null, orgId, subject, refundId);
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) onDone();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <p className="text-md">ההחזר לא נמחק: הוא נשאר ברשימה, מסומן כמבוטל, עם הסיבה, והתשלום נספר שוב בסכום הזה. שיוכים שהשתחררו לא חוזרים.</p>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextareaField
        label="סיבת הביטול"
        name="reason"
        required
        rows={3}
        maxLength={CANCEL_REASON_MAX}
        defaultValue={failure?.values?.reason ?? ""}
        error={failure?.fieldErrors?.reason}
      />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton variant="danger" pendingText="מבטלים…">
          ביטול ההחזר
        </SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          חזרה
        </Button>
      </div>
    </form>
  );
}
