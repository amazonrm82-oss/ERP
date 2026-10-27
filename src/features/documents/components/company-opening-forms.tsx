"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { TextareaField, TextField } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";

import { cancelCompanyOpeningBalanceAction, setCompanyOpeningBalanceAction } from "../actions";
import { CANCEL_REASON_MAX, parseSignedAgorot } from "../schema";

// GAP-12: the company card's opening balance: record or replace (the active one is cancelled), and cancel. Owners and admins.

function OpeningForm({ orgId, companyId, today, replaces, onDone }: { orgId: string; companyId: string; today: string; replaces: boolean; onDone: () => void }) {
  const action = setCompanyOpeningBalanceAction.bind(null, orgId, companyId);
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) onDone();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const values = failure?.values;
  const [amountText, setAmountText] = useState(values?.amount ?? "");
  const amount = parseSignedAgorot(amountText);
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <p className="text-sm text-ink-soft">
        יתרת החברה מהמערכת הקודמת, בלי מספר מסמך.
        {replaces ? " יתרת הפתיחה שכבר רשומה תבוטל ותוחלף בזו, ותשלומים וקיזוזים שהיו משויכים אליה ישתחררו." : ""}
      </p>
      <TextField
        label="סכום (₪)"
        name="amount"
        required
        dir="ltr"
        defaultValue={values?.amount ?? ""}
        onChange={(event) => setAmountText(event.target.value)}
        hint={"חוב של הלקוח: סכום חיובי. זכות של הלקוח: סכום עם מינוס, למשל ‎-500."}
        error={errors.amount}
      />
      <DateField label="היתרה נכונה לתאריך" name="doc_date" required defaultValue={values?.doc_date ?? today} error={errors.doc_date} />
      {amount === null || amount > 0 ? (
        <DateField
          label="מועד תשלום (רשות)"
          name="due_date"
          defaultValue={values?.due_date ?? ""}
          hint="רק לחוב. ריק = בלי מועד. מועד שכבר עבר מסמן את החוב באיחור."
          error={errors.due_date}
        />
      ) : (
        <input type="hidden" name="due_date" value="" />
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="שומרים…">שמירת היתרה</SubmitButton>
        <Button variant="ghost" onClick={onDone}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

/** "יתרת פתיחה" (or "החלפת יתרת הפתיחה") and its form. */
export function CompanyOpeningButton({ orgId, companyId, today, replaces }: { orgId: string; companyId: string; today: string; replaces: boolean }) {
  const [open, setOpen] = useState(false);
  const label = replaces ? "החלפת יתרת הפתיחה" : "רישום יתרת פתיחה";
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <PlusIcon className="size-4" />
        {label}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={label} variant="sheet">
        {open ? <OpeningForm orgId={orgId} companyId={companyId} today={today} replaces={replaces} onDone={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

function CancelForm({ orgId, companyId, documentId, onDone }: { orgId: string; companyId: string; documentId: string; onDone: () => void }) {
  const action = cancelCompanyOpeningBalanceAction.bind(null, orgId, companyId, documentId);
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) onDone();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <p className="text-md">הרישום לא נמחק: הוא נשאר ברשימה, מסומן כמבוטל, עם הסיבה. אי אפשר להחזיר אותו.</p>
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
          ביטול הרישום
        </SubmitButton>
        <Button variant="ghost" onClick={onDone}>
          חזרה
        </Button>
      </div>
    </form>
  );
}

/** Cancelling a company's opening balance, with a required reason. */
export function CancelCompanyOpeningButton({ orgId, companyId, documentId, label }: { orgId: string; companyId: string; documentId: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`ביטול הרישום: ${label}`}>
        ביטול
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`לבטל את רישום ${label}?`} variant="sheet">
        {open ? <CancelForm orgId={orgId} companyId={companyId} documentId={documentId} onDone={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}
