"use client";

import { useActionState, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { applyCreditLabel } from "@/features/allocations/credit";
import type { MoneySubject } from "@/features/payments/money-subject";
import type { FormState } from "@/lib/action-result";

import { applyCreditAction, cancelDocumentAction, recordDocumentAction, setDocumentDueDateAction } from "../actions";
import { ALLOCATION_NUMBER_MAX, takesAllocationNumber, type DocumentLineDraft } from "../details";
import {
  CANCEL_REASON_MAX,
  DOCUMENT_NUMBER_MAX,
  DOCUMENT_TYPE_LABELS,
  isDocumentType,
  isOpeningBalance,
  parseSignedAgorot,
  recordableTypes,
  takesDueDate,
  type DocumentType,
} from "../schema";
import { DocumentLinesEditor } from "./document-lines-editor";

type Subject = MoneySubject;

/** DOC-02: what a new document may name: the record's accepted quotes (its source) and its invoices (a credit's original). */
export type DocumentSources = { quotes: { id: string; label: string }[]; originals: { id: string; label: string }[] };
const NO_SOURCES: DocumentSources = { quotes: [], originals: [] };

function parseLineDrafts(json: string | undefined): DocumentLineDraft[] {
  if (!json) return [];
  try {
    const rows: unknown = JSON.parse(json);
    return Array.isArray(rows) ? (rows as DocumentLineDraft[]) : [];
  } catch {
    return [];
  }
}

/** DOC-02: the optional details of a document as printed on it, folded away until opened. */
function DetailsFields({
  docType,
  sources,
  errors,
  values,
}: {
  docType: DocumentType;
  sources: DocumentSources;
  errors: Record<string, string>;
  values: Record<string, string> | undefined;
}) {
  const opened = Boolean(values && (values.allocation_number || values.net || values.vat || values.quote_id || values.original_document_id || parseLineDrafts(values.lines).length > 0));
  return (
    <details className="rounded-lg border border-line p-3" open={opened || Object.keys(errors).some((key) => DETAIL_FIELDS.includes(key))}>
      <summary className="cursor-pointer text-md font-medium">פרטים נוספים מהמסמך (רשות)</summary>
      <div className="mt-3 space-y-4">
        {takesAllocationNumber(docType) ? (
          <TextField
            label="מספר הקצאה"
            name="allocation_number"
            dir="ltr"
            inputMode="numeric"
            maxLength={ALLOCATION_NUMBER_MAX}
            defaultValue={values?.allocation_number ?? ""}
            hint="המספר מרשות המסים, כפי שמופיע על החשבונית."
            error={errors.allocation_number}
          />
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TextField label='לפני מע"מ (₪)' name="net" dir="ltr" inputMode="decimal" defaultValue={values?.net ?? ""} error={errors.net} />
          <TextField label='מע"מ (₪)' name="vat" dir="ltr" inputMode="decimal" defaultValue={values?.vat ?? ""} error={errors.vat} />
          <TextField label='שיעור מע"מ (%)' name="vat_rate" dir="ltr" inputMode="decimal" defaultValue={values?.vat_rate ?? ""} error={errors.vat_rate} />
        </div>
        <p className="text-sm text-ink-soft">אם ממלאים: הסכום לפני מע&quot;מ ועוד המע&quot;מ שווים לסכום המסמך.</p>
        {sources.quotes.length > 0 ? (
          <SelectField label="הצעת המחיר שהמסמך הופק ממנה" name="quote_id" defaultValue={values?.quote_id ?? ""} error={errors.quote_id}>
            <option value="">בלי</option>
            {sources.quotes.map((quote) => (
              <option key={quote.id} value={quote.id}>
                {quote.label}
              </option>
            ))}
          </SelectField>
        ) : null}
        {docType === "credit_invoice" && sources.originals.length > 0 ? (
          <SelectField label="המסמך המקורי" name="original_document_id" defaultValue={values?.original_document_id ?? ""} error={errors.original_document_id}>
            <option value="">בלי</option>
            {sources.originals.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.label}
              </option>
            ))}
          </SelectField>
        ) : null}
        <DocumentLinesEditor initial={parseLineDrafts(values?.lines)} />
      </div>
    </details>
  );
}
const DETAIL_FIELDS = ["allocation_number", "net", "vat", "vat_rate", "quote_id", "original_document_id"];

function RecordForm({
  orgId,
  subject,
  today,
  credit,
  canOpening,
  sources,
  onDone,
  onCancel,
}: {
  orgId: string;
  subject: Subject;
  today: string;
  credit: number;
  canOpening: boolean;
  sources: DocumentSources;
  onDone: (message: string | null) => void;
  onCancel: () => void;
}) {
  const action = recordDocumentAction.bind(null, orgId, subject);
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) onDone(result.message ?? null);
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const values = failure?.values;
  const [docType, setDocType] = useState(values?.doc_type ?? "");
  // GAP-12: an opening balance has no number, may be negative (a credit), and is dated by the day it stands on
  const opening = isDocumentType(docType) && isOpeningBalance(docType);
  // GAP-12: a negative opening balance is a credit: no due date and no credit to apply (unknown while the amount is not valid)
  const [amountText, setAmountText] = useState(values?.amount ?? "");
  const amount = parseSignedAgorot(amountText) ?? undefined;
  const hasBalance = isDocumentType(docType) && takesDueDate(docType, amount);
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <SelectField label="סוג המסמך" name="doc_type" required value={docType} onChange={(event) => setDocType(event.target.value)} error={errors.doc_type}>
        <option value="">בחירה</option>
        {recordableTypes(canOpening).map((type) => (
          <option key={type} value={type}>
            {DOCUMENT_TYPE_LABELS[type]}
          </option>
        ))}
      </SelectField>
      {opening ? (
        <p className="text-sm text-ink-soft">
          יתרת הלקוח מהמערכת הקודמת, בלי מספר מסמך. ללקוח יש יתרת פתיחה אחת: יתרה שכבר רשומה תבוטל ותוחלף בזו. אם יש לה תשלומים או קיזוזים משויכים, קודם בטלו את השיוכים. רק בעלים ומנהלי מערכת רושמים, משנים ומבטלים אותה.
        </p>
      ) : (
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
      )}
      <DateField
        label={opening ? "היתרה נכונה לתאריך" : "תאריך המסמך"}
        name="doc_date"
        required
        defaultValue={values?.doc_date ?? today}
        error={errors.doc_date}
      />
      <TextField
        label="סכום (₪)"
        name="amount"
        required
        dir="ltr"
        inputMode={opening ? "text" : "decimal"}
        defaultValue={values?.amount ?? ""}
        onChange={(event) => setAmountText(event.target.value)}
        hint={opening ? "חוב של הלקוח: סכום חיובי. זכות של הלקוח: סכום עם מינוס, למשל \u200e-500." : "הסכום הכולל שעל המסמך."}
        error={errors.amount}
      />
      {hasBalance ? (
        <DateField
          label="מועד תשלום (רשות)"
          name="due_date"
          defaultValue={values?.due_date ?? ""}
          hint={
            opening
              ? "רק לחוב. ריק = בלי מועד (לא לפי תנאי התשלום). מועד שכבר עבר מסמן את החוב באיחור."
              : "ריק = לפי תנאי התשלום של הלקוח. אפשר לשנות אחר כך בכרטיס."
          }
          error={errors.due_date}
        />
      ) : null}
      {isDocumentType(docType) && !opening ? <DetailsFields docType={docType} sources={sources} errors={errors} values={values} /> : null}
      {credit > 0 && hasBalance ? (
        // PAY-03: the customer's credit is allocated to the new document, oldest payment first, up to its amount
        <Checkbox
          name="apply_credit"
          label={applyCreditLabel(credit)}
          hint="הסכום משויך מהתשלומים הוותיקים קודם, עד סכום המסמך. אפשר לבטל שיוך אחר כך."
          defaultChecked={values ? values.apply_credit === "on" : true}
        />
      ) : null}
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
export function RecordDocumentButton({
  orgId,
  subject,
  today,
  credit = 0,
  canOpening = false,
  sources = NO_SOURCES,
}: {
  orgId: string;
  subject: Subject;
  today: string;
  credit?: number;
  // GAP-12: owners and admins also record an opening balance
  canOpening?: boolean;
  // DOC-02: the accepted quotes and the invoices a new document may name as its source or original
  sources?: DocumentSources;
}) {
  const [open, setOpen] = useState(false);
  // PAY-03: what the last save said (the credit it allocated), shown beside the button after the window closes
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <span className="flex flex-wrap items-center gap-2">
      {notice ? (
        <span role="status" className="text-sm text-ink-soft">
          {notice}
        </span>
      ) : null}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setNotice(null);
          setOpen(true);
        }}
      >
        <PlusIcon className="size-4" />
        רישום מסמך
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="רישום מסמך שהופק מחוץ למערכת" variant="sheet">
        {open ? (
          <RecordForm
            orgId={orgId}
            subject={subject}
            today={today}
            credit={credit}
            canOpening={canOpening}
            sources={sources}
            onDone={(message) => {
              setOpen(false);
              setNotice(message && message !== "המסמך נרשם." ? message : null);
            }}
            onCancel={() => setOpen(false)}
          />
        ) : null}
      </Dialog>
    </span>
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

/** PAY-02 answer 7: the due date of an active tax invoice or proforma, changed on the card (empty clears it). */
export function DueDateButton({ orgId, subject, documentId, label, dueDate }: { orgId: string; subject: Subject; documentId: string; label: string; dueDate: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`מועד התשלום של ${label}`}>
        מועד תשלום
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`מועד התשלום של ${label}`} variant="sheet">
        {open ? <DueDateForm orgId={orgId} subject={subject} documentId={documentId} dueDate={dueDate} onDone={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

function DueDateForm({ orgId, subject, documentId, dueDate, onDone }: { orgId: string; subject: Subject; documentId: string; dueDate: string | null; onDone: () => void }) {
  const action = setDocumentDueDateAction.bind(null, orgId, subject, documentId);
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
      <DateField
        label="מועד תשלום"
        name="due_date"
        defaultValue={failure?.values?.due_date ?? dueDate ?? ""}
        hint="ריק = בלי מועד. מסמך שהמועד שלו עבר ויש בו יתרה מסומן באיחור."
        error={failure?.fieldErrors?.due_date}
      />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="שומרים…">שמירה</SubmitButton>
        <Button variant="ghost" onClick={onDone}>
          חזרה
        </Button>
      </div>
    </form>
  );
}

/**
 * GAP-12 (owner's answer (2) ג of 27 October 2026): offsets the customer's credit against this open document: the advances of
 * its order first, then payments and opening credits together, oldest first.
 */
export function ApplyCreditButton({ orgId, subject, documentId, label }: { orgId: string; subject: Subject; documentId: string; label: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {message ? (
        <span role="status" className="text-sm text-ink-soft">
          {message}
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        aria-label={`קיזוז מיתרת הזכות: ${label}`}
        onClick={() =>
          startTransition(async () => {
            const result = await applyCreditAction(orgId, subject, documentId);
            setMessage(result?.ok ? (result.message ?? null) : (result?.message ?? "הקיזוז לא הצליח."));
          })
        }
      >
        {pending ? "מקזזים…" : "קיזוז מיתרת הזכות"}
      </Button>
    </span>
  );
}
