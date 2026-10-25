"use client";

import { useActionState, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Select, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";

import { cancelPaymentAction, correctPaymentAction, recordPaymentAction, setPaymentStatusAction } from "../actions";
import { CHEQUE_BANK_NAME_MAX, CHEQUE_NUMBER_MAX, CHEQUE_STATUS_LABELS, CHEQUE_STATUSES, ISRAELI_BANKS, OTHER_BANK, OTHER_BANK_LABEL } from "../cheques";
import type { MoneySubject } from "../money-subject";
import {
  CANCEL_REASON_MAX,
  NEW_PAYMENT_STATUSES,
  PAYMENT_INSTALLMENTS_MAX,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  PAYMENT_NOTE_MAX,
  PAYMENT_REFERENCE_MAX,
  PAYMENT_STATUS_LABELS,
  statusChoices,
  type PaymentMethod,
  type PaymentStatus,
} from "../schema";

type Subject = MoneySubject;

/** The values a correction starts from (the amount as typed in shekels). */
export type PaymentFormValues = {
  amount: string;
  paid_on: string;
  method: PaymentMethod;
  installments: string;
  reference: string;
  note: string;
  // PAY-04
  cheque_number?: string;
  cheque_bank?: string;
  cheque_bank_name?: string;
  cheque_branch?: string;
  cheque_due_date?: string;
  cheque_status?: string;
};

/** PAY-04: a cheque's details (answer 5: a listed bank and a 3-digit branch, or "other" with the bank's name). */
export function ChequeFieldsInputs({
  values,
  errors,
  today,
  withStatus,
  numberLabel = "מספר הצ'ק",
}: {
  values?: Partial<Record<string, string>>;
  errors: Record<string, string>;
  today: string;
  // the status is chosen on a new cheque; afterwards it moves on the card (hidden here, kept as it is)
  withStatus: boolean;
  numberLabel?: string;
}) {
  const [bank, setBank] = useState<string>(values?.cheque_bank ?? "");
  return (
    <>
      <TextField
        label={numberLabel}
        name="cheque_number"
        required
        dir="ltr"
        inputMode="numeric"
        maxLength={CHEQUE_NUMBER_MAX}
        defaultValue={values?.cheque_number ?? ""}
        error={errors.cheque_number}
      />
      <SelectField label="בנק" name="cheque_bank" required value={bank} onChange={(event) => setBank(event.target.value)} error={errors.cheque_bank}>
        <option value="">בחירה</option>
        {ISRAELI_BANKS.map((b) => (
          <option key={b.code} value={b.code}>
            {b.name} ({b.code})
          </option>
        ))}
        <option value={OTHER_BANK}>{OTHER_BANK_LABEL}</option>
      </SelectField>
      {bank === OTHER_BANK ? (
        <TextField
          label="שם הבנק"
          name="cheque_bank_name"
          required
          maxLength={CHEQUE_BANK_NAME_MAX}
          defaultValue={values?.cheque_bank_name ?? ""}
          error={errors.cheque_bank_name}
        />
      ) : null}
      <TextField
        label="סניף"
        name="cheque_branch"
        required={bank !== OTHER_BANK}
        dir="ltr"
        inputMode="numeric"
        maxLength={3}
        defaultValue={values?.cheque_branch ?? ""}
        hint={bank === OTHER_BANK ? "3 ספרות, אפשר להשאיר ריק." : "3 ספרות."}
        error={errors.cheque_branch}
      />
      <DateField label="תאריך פירעון" name="cheque_due_date" required defaultValue={values?.cheque_due_date ?? today} error={errors.cheque_due_date} />
      {withStatus ? (
        <SelectField label="מצב הצ'ק" name="cheque_status" required defaultValue={values?.cheque_status ?? "in_hand"} error={errors.cheque_status}>
          {CHEQUE_STATUSES.filter((s) => s !== "bounced").map((s) => (
            <option key={s} value={s}>
              {CHEQUE_STATUS_LABELS[s]}
            </option>
          ))}
        </SelectField>
      ) : (
        <input type="hidden" name="cheque_status" value={values?.cheque_status ?? ""} />
      )}
    </>
  );
}

function PaymentFields({
  values,
  errors,
  today,
  isNew,
}: {
  values?: Partial<Record<string, string>>;
  errors: Record<string, string>;
  today: string;
  isNew: boolean;
}) {
  const [method, setMethod] = useState<string>(values?.method ?? "");
  return (
    <>
      <TextField
        label="סכום (₪)"
        name="amount"
        required
        dir="ltr"
        inputMode="decimal"
        defaultValue={values?.amount ?? ""}
        hint="הסכום שהתקבל, כולל מע״מ."
        error={errors.amount}
      />
      <DateField label="תאריך התשלום" name="paid_on" required defaultValue={values?.paid_on ?? today} error={errors.paid_on} />
      <SelectField label="אמצעי תשלום" name="method" required value={method} onChange={(event) => setMethod(event.target.value)} error={errors.method}>
        <option value="">בחירה</option>
        {PAYMENT_METHODS.map((m) => (
          <option key={m} value={m}>
            {PAYMENT_METHOD_LABELS[m]}
          </option>
        ))}
      </SelectField>
      {method === "credit" ? (
        <TextField
          label="מספר תשלומים"
          name="installments"
          dir="ltr"
          inputMode="numeric"
          defaultValue={values?.installments ?? "1"}
          hint={`1 עד ${PAYMENT_INSTALLMENTS_MAX}.`}
          error={errors.installments}
        />
      ) : null}
      {method === "cheque" ? <ChequeFieldsInputs values={values} errors={errors} today={today} withStatus={isNew || !values?.cheque_status} /> : null}
      <TextField
        label="אסמכתא"
        name="reference"
        dir="ltr"
        maxLength={PAYMENT_REFERENCE_MAX}
        defaultValue={values?.reference ?? ""}
        hint="מספר אישור, מספר העברה או מספר צ'ק."
        error={errors.reference}
      />
      <TextareaField label="הערה" name="note" rows={2} maxLength={PAYMENT_NOTE_MAX} defaultValue={values?.note ?? ""} error={errors.note} />
      {isNew && method !== "cheque" ? (
        <SelectField label="מצב" name="status" defaultValue={values?.status ?? "recorded"}>
          {NEW_PAYMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PAYMENT_STATUS_LABELS[s]}
            </option>
          ))}
        </SelectField>
      ) : null}
    </>
  );
}

function PaymentForm({
  action,
  today,
  initial,
  submitLabel,
  onDone,
  onCancel,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  today: string;
  initial?: PaymentFormValues;
  submitLabel: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) onDone();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <PaymentFields values={failure?.values ?? initial} errors={failure?.fieldErrors ?? {}} today={today} isNew={!initial} />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="שומרים…">{submitLabel}</SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

/** PAY-01: "רישום תשלום" and its form, for whoever may record payments. */
export function RecordPaymentButton({ orgId, subject, today }: { orgId: string; subject: Subject; today: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <PlusIcon className="size-4" />
        רישום תשלום
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="רישום תשלום שהתקבל" variant="sheet">
        {open ? (
          <PaymentForm
            action={recordPaymentAction.bind(null, orgId, subject)}
            today={today}
            submitLabel="רישום התשלום"
            onDone={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        ) : null}
      </Dialog>
    </>
  );
}

/** PAY-06: correcting a payment's details, for owners and admins. */
export function CorrectPaymentButton({
  orgId,
  subject,
  paymentId,
  initial,
  today,
  label,
}: {
  orgId: string;
  subject: Subject;
  paymentId: string;
  initial: PaymentFormValues;
  today: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`תיקון התשלום: ${label}`}>
        תיקון
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="תיקון תשלום" description="התיקון נרשם ביומן הפעולות." variant="sheet">
        {open ? (
          <PaymentForm
            action={correctPaymentAction.bind(null, orgId, subject, paymentId)}
            today={today}
            initial={initial}
            submitLabel="שמירת התיקון"
            onDone={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        ) : null}
      </Dialog>
    </>
  );
}

/** PAY-06 (owner, 20 October 2026): cancelling a payment with a required reason, for owners and admins; never deleting. */
export function CancelPaymentButton({ orgId, subject, paymentId, label }: { orgId: string; subject: Subject; paymentId: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger-ghost" size="sm" onClick={() => setOpen(true)} aria-label={`ביטול התשלום: ${label}`}>
        ביטול
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`לבטל את התשלום ${label}?`} variant="sheet">
        {open ? <CancelForm orgId={orgId} subject={subject} paymentId={paymentId} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

function CancelForm({
  orgId,
  subject,
  paymentId,
  onDone,
  onCancel,
}: {
  orgId: string;
  subject: Subject;
  paymentId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const action = cancelPaymentAction.bind(null, orgId, subject, paymentId);
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) onDone();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <p className="text-md">התשלום לא נמחק: הוא נשאר ברשימה, מסומן כמבוטל, עם הסיבה, ולא נספר בסכום שהתקבל. אי אפשר להחזיר אותו.</p>
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
          ביטול התשלום
        </SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          חזרה
        </Button>
      </div>
    </form>
  );
}

/** The payment's status, as a choice for whoever may move it (refunded only for owners and admins). */
export function PaymentStatusSelect({
  orgId,
  subject,
  paymentId,
  status,
  canCorrect,
  label,
}: {
  orgId: string;
  subject: Subject;
  paymentId: string;
  status: PaymentStatus;
  canCorrect: boolean;
  label: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const choices = statusChoices(status, canCorrect);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Select
        controlSize="sm"
        aria-label={`מצב התשלום: ${label}`}
        value={status}
        disabled={pending || choices.length === 0}
        onChange={(event) => {
          const next = event.target.value;
          setError(null);
          startTransition(async () => {
            const result = await setPaymentStatusAction(orgId, subject, paymentId, next);
            if (!result.ok) setError(result.message);
          });
        }}
      >
        <option value={status}>{PAYMENT_STATUS_LABELS[status]}</option>
        {choices.map((s) => (
          <option key={s} value={s}>
            {PAYMENT_STATUS_LABELS[s]}
          </option>
        ))}
      </Select>
      {error ? (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
