"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";

import { cancelDocumentAction, recordDocumentAction } from "../actions";
import { CANCEL_REASON_MAX, DOCUMENT_NUMBER_MAX, DOCUMENT_TYPE_LABELS, DOCUMENT_TYPES } from "../schema";

type Subject = { kind: "deal" | "contact"; id: string };

function RecordForm({ orgId, subject, today, onDone, onCancel }: { orgId: string; subject: Subject; today: string; onDone: () => void; onCancel: () => void }) {
  const action = recordDocumentAction.bind(null, orgId, subject);
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) onDone();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const values = failure?.values;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <SelectField label="סוג המסמך" name="doc_type" required defaultValue={values?.doc_type ?? ""} error={errors.doc_type}>
        <option value="">בחירה</option>
        {DOCUMENT_TYPES.map((type) => (
          <option key={type} value={type}>
            {DOCUMENT_TYPE_LABELS[type]}
          </option>
        ))}
      </SelectField>
      <TextField
        label="מספר המסמך"
        name="number"
        required
        dir="ltr"
        maxLength={DOCUMENT_NUMBER_MAX}
        defaultValue={values?.number ?? ""}
        hint="כפי שהוא מופיע על המסמך."
        error={errors.number}
      />
      <DateField label="תאריך המסמך" name="doc_date" required defaultValue={values?.doc_date ?? today} error={errors.doc_date} />
      <TextField label="סכום (₪)" name="amount" required dir="ltr" inputMode="decimal" defaultValue={values?.amount ?? ""} hint='הסכום הכולל שעל המסמך.' error={errors.amount} />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="שומרים…">רישום המסמך</SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

/** DOC-01: "רישום מסמך" and its form, for whoever may record documents. */
export function RecordDocumentButton({ orgId, subject, today }: { orgId: string; subject: Subject; today: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <PlusIcon className="size-4" />
        רישום מסמך
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="רישום מסמך שהופק מחוץ למערכת" variant="sheet">
        {open ? <RecordForm orgId={orgId} subject={subject} today={today} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

function CancelForm({ orgId, subject, documentId, onDone, onCancel }: { orgId: string; subject: Subject; documentId: string; onDone: () => void; onCancel: () => void }) {
  const action = cancelDocumentAction.bind(null, orgId, subject, documentId);
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
        <Button variant="ghost" onClick={onCancel}>
          חזרה
        </Button>
      </div>
    </form>
  );
}

/** DOC-01: cancelling a recorded document, with a required reason. */
export function CancelDocumentButton({ orgId, subject, documentId, label }: { orgId: string; subject: Subject; documentId: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`ביטול הרישום: ${label}`}>
        ביטול
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`לבטל את רישום ${label}?`} variant="sheet">
        {open ? <CancelForm orgId={orgId} subject={subject} documentId={documentId} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}
