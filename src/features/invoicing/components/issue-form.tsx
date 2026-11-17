"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextField } from "@/components/ui/field";
import { PlusIcon, TrashIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { documentTotals } from "@/features/tax/calc";
import type { FormState } from "@/lib/action-result";
import { formatMoney } from "@/lib/format";

import { issueDocumentAction } from "../issue-actions";
import { DOCUMENT_TYPE_LABELS } from "@/features/documents/schema";

import { EMPTY_ISSUE_LINE, ISSUE_LINES_MAX, isIssuableType, issuableTypesFor, issueLineFrom, issueTakesDueDate, type IssueLineDraft, type IssueSourceKind } from "../issue";
import type { IssuableDocumentType } from "../providers/types";

type Props = {
  orgId: string;
  source: { kind: IssueSourceKind; id: string };
  idempotencyKey: string;
  initialLines: IssueLineDraft[];
  defaultType: IssuableDocumentType;
  today: string;
  timeZone: string;
  rateBp: number | null;
  pricesIncludeVat: boolean;
  blocked: boolean;
  /** false = the business charges no VAT: no tax invoice is offered (invoice:type_exempt) */
  chargesVat: boolean | null;
};

/**
 * DOC-07: the document before it is issued: type, date, due date, the source's lines (editable), and the totals as they will
 * be printed. Pressing "הפקה" queues one request with its key (DOC-09); a second press, or a retry after a network failure,
 * reaches the same request, which the background worker sends to the provider (owner (398) א). After issuing nothing changes here: a mistake is corrected only by a credit invoice (DOC-14).
 * The preview's totals are worked out like the database does (documentTotals = app.document_totals); the database decides.
 */
export function IssueForm({ orgId, source, idempotencyKey, initialLines, defaultType, today, timeZone, rateBp, pricesIncludeVat, blocked, chargesVat }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(issueDocumentAction.bind(null, orgId, source), null);
  const values = state && !state.ok ? state.values : undefined;
  const types = issuableTypesFor(chargesVat);
  const offered = (value: unknown): value is IssuableDocumentType => isIssuableType(value) && types.includes(value);
  const [type, setType] = useState<IssuableDocumentType>(() => (offered(values?.doc_type) ? values.doc_type : offered(defaultType) ? defaultType : types[0]));
  const [lines, setLines] = useState<IssueLineDraft[]>(initialLines);
  const update = (index: number, patch: Partial<IssueLineDraft>) => setLines((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const parsed = lines.map(issueLineFrom);
  const valid = parsed.every((line) => line !== null) && parsed.length > 0;
  // a receipt is the money received: its amounts are what was paid, no VAT added (as app.invoice_issue_open)
  const docRate = rateBp === null ? null : type === "receipt" ? 0 : rateBp;
  const totals =
    valid && docRate !== null
      ? documentTotals(
          parsed.map((line) => ({ quantity: line!.quantity, unitPriceAgorot: line!.unit_price_agorot, discountAgorot: line!.discount_agorot, vatExempt: line!.vat_exempt })),
          { rateBp: docRate, pricesIncludeVat },
        )
      : null;
  const key = values?.key ?? idempotencyKey;
  return (
    <form action={formAction} className="space-y-5">
      <FormGuard state={state} />
      <input type="hidden" name="key" value={key} />
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      <input type="hidden" name="prices_include_vat" value={pricesIncludeVat ? "true" : "false"} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SelectField label="סוג המסמך" name="doc_type" value={type} onChange={(event) => offered(event.target.value) && setType(event.target.value)}>
          {types.map((value) => (
            <option key={value} value={value}>
              {DOCUMENT_TYPE_LABELS[value]}
            </option>
          ))}
        </SelectField>
        <DateField label="תאריך המסמך" name="doc_date" defaultValue={values?.doc_date ?? today} max={today} timeZone={timeZone} required />
        {issueTakesDueDate(type) ? (
          <DateField label="לתשלום עד (רשות)" name="due_date" defaultValue={values?.due_date ?? ""} min={today} timeZone={timeZone} hint="ריק: לפי תנאי התשלום של הלקוח" />
        ) : (
          <input type="hidden" name="due_date" value="" />
        )}
      </div>

      <fieldset className="space-y-3">
        <legend className="text-md font-medium">שורות המסמך</legend>
        <p className="text-sm text-ink-soft">{pricesIncludeVat ? 'המחירים כוללים מע"מ.' : 'המחירים לפני מע"מ.'} אפשר לשנות, להוסיף ולהסיר שורות לפני ההפקה.</p>
        {lines.map((line, index) => (
          <div key={index} className="space-y-3 rounded-lg border border-line p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">שורה {index + 1}</span>
              {lines.length > 1 ? (
                <Button variant="ghost" size="sm" onClick={() => setLines((rows) => rows.filter((_, i) => i !== index))} aria-label={`הסרת שורה ${index + 1}`}>
                  <TrashIcon className="size-4" />
                  הסרה
                </Button>
              ) : null}
            </div>
            <TextField label="תיאור" value={line.description} maxLength={500} required onChange={(event) => update(index, { description: event.target.value })} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <TextField label="כמות" dir="ltr" inputMode="decimal" value={line.quantity} onChange={(event) => update(index, { quantity: event.target.value })} />
              <TextField label="מחיר ליחידה (₪)" dir="ltr" inputMode="decimal" value={line.unitPrice} onChange={(event) => update(index, { unitPrice: event.target.value })} />
              <TextField label="הנחה בשורה (₪)" dir="ltr" inputMode="decimal" value={line.discount} onChange={(event) => update(index, { discount: event.target.value })} />
            </div>
            <Checkbox label='פטור ממע"מ' checked={line.vatExempt} onChange={(event) => update(index, { vatExempt: event.target.checked })} />
            {parsed[index] === null ? <p className="text-sm text-danger">חסר תיאור, או שהכמות או המחיר לא תקינים.</p> : null}
          </div>
        ))}
        {lines.length < ISSUE_LINES_MAX ? (
          <Button variant="secondary" size="sm" onClick={() => setLines((rows) => [...rows, { ...EMPTY_ISSUE_LINE }])}>
            <PlusIcon className="size-4" />
            הוספת שורה
          </Button>
        ) : null}
      </fieldset>

      <section aria-labelledby="issue-preview" className="space-y-1 rounded-lg bg-canvas p-4">
        <h2 id="issue-preview" className="text-md font-medium">
          תצוגה מקדימה
        </h2>
        {rateBp === null ? (
          <p className="text-sm text-ink-soft">{'קודם בוחרים את המעמד של העסק במע"מ, בהגדרות "מע"מ ופרטים למסמכים".'}</p>
        ) : totals && totals.ok ? (
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
            <dt>{'לפני מע"מ'}</dt>
            <dd className="tabular-nums">{formatMoney(totals.totals.netTotalAgorot)}</dd>
            <dt>{docRate !== null && docRate > 0 ? `מע"מ (${docRate / 100}%)` : 'מע"מ'}</dt>
            <dd className="tabular-nums">{formatMoney(totals.totals.vatAgorot)}</dd>
            <dt className="font-medium">{'סה"כ לתשלום'}</dt>
            <dd className="font-medium tabular-nums">{formatMoney(totals.totals.totalAgorot)}</dd>
          </dl>
        ) : (
          <p className="text-sm text-ink-soft">הסכומים יוצגו כשכל השורות תקינות.</p>
        )}
        <p className="text-sm text-ink-soft">אחרי ההפקה אי אפשר לערוך את המסמך. טעות מתקנים בחשבונית זיכוי.</p>
      </section>

      <FormError message={state && !state.ok ? state.message : null} />
      <SubmitButton disabled={blocked || !valid || rateBp === null} pendingText="מפיקים…">
        הפקת המסמך
      </SubmitButton>
    </form>
  );
}
