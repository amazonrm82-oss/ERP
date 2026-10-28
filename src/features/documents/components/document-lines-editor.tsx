"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox, TextField } from "@/components/ui/field";
import { PlusIcon, TrashIcon } from "@/components/ui/icons";
import { formatMoney, parseMoneyToAgorot } from "@/lib/format";

import { DOCUMENT_LINES_MAX, documentLineTotal, EMPTY_LINE, LINE_DESCRIPTION_MAX, type DocumentLineDraft } from "../details";

/** The total of a typed row, or null while it is not a valid line yet. */
function rowTotal(line: DocumentLineDraft): number | null {
  const quantity = Number(line.quantity.trim().replace(/,/g, ""));
  const unit = parseMoneyToAgorot(line.unitPrice);
  const discount = parseMoneyToAgorot(line.discount);
  if (!Number.isFinite(quantity) || quantity <= 0 || unit === null || discount === null) return null;
  const total = documentLineTotal({ quantity, unitPriceAgorot: unit, discountAgorot: discount });
  return total < 0 ? null : total;
}

/**
 * DOC-02: the document's lines as printed on it (optional). Each row is a card (works at 360px): description, quantity, unit
 * price, line discount and "פטור ממע"מ". The rows travel as JSON in the hidden field `lines`; the server checks them again and
 * the database works out each line's total. Lines are recorded with the document and never change afterwards.
 */
export function DocumentLinesEditor({ initial }: { initial: DocumentLineDraft[] }) {
  const [lines, setLines] = useState<DocumentLineDraft[]>(initial);
  const update = (index: number, patch: Partial<DocumentLineDraft>) => setLines((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const totals = lines.map(rowTotal);
  const sum = totals.every((t) => t !== null) ? totals.reduce<number>((acc, t) => acc + (t ?? 0), 0) : null;
  return (
    <fieldset className="space-y-3">
      <legend className="text-md font-medium">שורות המסמך (רשות)</legend>
      <p className="text-sm text-ink-soft">כפי שהן מופיעות על המסמך. השורות נשמרות עם המסמך ולא משתנות אחר כך. הסכום שלהן לא חייב להיות שווה לסכום המסמך (הנחה כללית, מע&quot;מ).</p>
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      {lines.map((line, index) => {
        const total = totals[index];
        return (
        <div key={index} className="space-y-3 rounded-lg border border-line p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">שורה {index + 1}</span>
            <Button variant="ghost" size="sm" onClick={() => setLines((rows) => rows.filter((_, i) => i !== index))} aria-label={`הסרת שורה ${index + 1}`}>
              <TrashIcon className="size-4" />
              הסרה
            </Button>
          </div>
          <TextField
            label="תיאור"
            value={line.description}
            maxLength={LINE_DESCRIPTION_MAX}
            onChange={(event) => update(index, { description: event.target.value })}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <TextField label="כמות" dir="ltr" inputMode="decimal" value={line.quantity} onChange={(event) => update(index, { quantity: event.target.value })} />
            <TextField label="מחיר ליחידה (₪)" dir="ltr" inputMode="decimal" value={line.unitPrice} onChange={(event) => update(index, { unitPrice: event.target.value })} />
            <TextField label="הנחה בשורה (₪)" dir="ltr" inputMode="decimal" value={line.discount} onChange={(event) => update(index, { discount: event.target.value })} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Checkbox label='פטור ממע"מ' checked={line.vatExempt} onChange={(event) => update(index, { vatExempt: event.target.checked })} />
            <span className="text-sm text-ink-soft">
              סה&quot;כ שורה: <span className="tabular-nums">{total === null ? "—" : formatMoney(total)}</span>
            </span>
          </div>
        </div>
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {lines.length < DOCUMENT_LINES_MAX ? (
          <Button variant="secondary" size="sm" onClick={() => setLines((rows) => [...rows, { ...EMPTY_LINE }])}>
            <PlusIcon className="size-4" />
            הוספת שורה
          </Button>
        ) : (
          <span className="text-sm text-ink-soft">במסמך יש עד {DOCUMENT_LINES_MAX} שורות.</span>
        )}
        {lines.length > 0 ? (
          <span className="text-sm">
            סכום השורות: <span className="font-medium tabular-nums">{sum === null ? "—" : formatMoney(sum)}</span>
          </span>
        ) : null}
      </div>
    </fieldset>
  );
}
