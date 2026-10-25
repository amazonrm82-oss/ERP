"use client";

import { useActionState, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Select, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";

import { recordChequeSeriesAction, setChequeStatusAction } from "../actions";
import { CHEQUE_SERIES_MAX, CHEQUE_STATUS_LABELS, chequeStatusChoices, UNBOUNCE_REASON_MAX, type ChequeStatus } from "../cheques";
import type { MoneySubject } from "../money-subject";
import { ChequeFieldsInputs } from "./payment-forms";

// PAY-04: a cheque's status on its payment's row, and "סדרת צ'קים".

/** Answers 2-4: the cheque's status (its payment follows); out of "bounced" only owners and admins, with a reason. */
export function ChequeStatusSelect({
  orgId,
  subject,
  paymentId,
  status,
  isAdmin,
  label,
}: {
  orgId: string;
  subject: MoneySubject;
  paymentId: string;
  status: ChequeStatus;
  isAdmin: boolean;
  label: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState<ChequeStatus | null>(null);
  const choices = chequeStatusChoices(status, isAdmin);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Select
        controlSize="sm"
        aria-label={`מצב הצ'ק: ${label}`}
        value={status}
        disabled={pending || choices.length === 0}
        onChange={(event) => {
          const next = event.target.value as ChequeStatus;
          setError(null);
          if (status === "bounced") {
            setAsking(next);
            return;
          }
          startTransition(async () => {
            const result = await setChequeStatusAction(orgId, subject, paymentId, next, null);
            if (!result.ok) setError(result.message);
          });
        }}
      >
        <option value={status}>{CHEQUE_STATUS_LABELS[status]}</option>
        {choices.map((s) => (
          <option key={s} value={s}>
            {CHEQUE_STATUS_LABELS[s]}
          </option>
        ))}
      </Select>
      {error ? (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      ) : null}
      <Dialog open={asking !== null} onClose={() => setAsking(null)} title={`החזרת הצ'ק ממצב "חזר": ${label}`} variant="sheet">
        {asking ? <UnbounceForm orgId={orgId} subject={subject} paymentId={paymentId} next={asking} onDone={() => setAsking(null)} /> : null}
      </Dialog>
    </span>
  );
}

function UnbounceForm({ orgId, subject, paymentId, next, onDone }: { orgId: string; subject: MoneySubject; paymentId: string; next: ChequeStatus; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="space-y-4">
      <p className="text-md">
        הצ&apos;ק יעבור למצב &quot;{CHEQUE_STATUS_LABELS[next]}&quot;, והתשלום יחזור להיספר. הסיבה נשמרת ביומן הפעולות.
      </p>
      <FormError message={error} />
      <TextareaField label="סיבה" rows={3} maxLength={UNBOUNCE_REASON_MAX} required value={reason} onChange={(event) => setReason(event.target.value)} />
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await setChequeStatusAction(orgId, subject, paymentId, next, reason);
              if (!result.ok) {
                setError(result.message);
                return;
              }
              onDone();
            });
          }}
        >
          {pending ? "שומרים…" : "החזרה"}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          חזרה
        </Button>
      </div>
    </div>
  );
}

/** Answer 1: "סדרת צ'קים" makes N cheques, each its own payment, in one save. */
export function ChequeSeriesButton({ orgId, subject, today }: { orgId: string; subject: MoneySubject; today: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        סדרת צ&apos;קים
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="רישום סדרת צ'קים" variant="sheet">
        {open ? <SeriesForm orgId={orgId} subject={subject} today={today} onDone={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

function SeriesForm({ orgId, subject, today, onDone }: { orgId: string; subject: MoneySubject; today: string; onDone: () => void }) {
  const action = recordChequeSeriesAction.bind(null, orgId, subject);
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) onDone();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const [step, setStep] = useState(values?.step ?? "month");
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <p className="text-md">כל צ&apos;ק נרשם כתשלום נפרד. המספרים עולים באחד מהצ&apos;ק הראשון, ותאריכי הפירעון לפי המרווח שבוחרים.</p>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextField
        label="כמה צ'קים"
        name="count"
        required
        dir="ltr"
        inputMode="numeric"
        defaultValue={values?.count ?? "12"}
        hint={`2 עד ${CHEQUE_SERIES_MAX}.`}
        error={errors.count}
      />
      <TextField
        label="סכום כל צ'ק (₪)"
        name="amount"
        required
        dir="ltr"
        inputMode="decimal"
        defaultValue={values?.amount ?? ""}
        error={errors.amount}
      />
      <DateField label="תאריך הקבלה" name="paid_on" required defaultValue={values?.paid_on ?? today} error={errors.paid_on} />
      <ChequeFieldsInputs values={values} errors={errors} today={today} withStatus numberLabel="מספר הצ'ק הראשון" />
      <SelectField label="מרווח בין תאריכי הפירעון" name="step" value={step} onChange={(event) => setStep(event.target.value)}>
        <option value="month">כל חודש</option>
        <option value="days">כל כמה ימים</option>
      </SelectField>
      {step === "days" ? (
        <TextField label="כל כמה ימים" name="days" required dir="ltr" inputMode="numeric" defaultValue={values?.days ?? "30"} error={errors.days} />
      ) : null}
      <TextField label="אסמכתא" name="reference" dir="ltr" defaultValue={values?.reference ?? ""} error={errors.reference} />
      <TextareaField label="הערה" name="note" rows={2} defaultValue={values?.note ?? ""} error={errors.note} />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="רושמים…">רישום הסדרה</SubmitButton>
        <Button variant="ghost" onClick={onDone}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
