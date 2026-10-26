"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { SelectField, TextField } from "@/components/ui/field";
import { TrashIcon } from "@/components/ui/icons";
import { CHEQUE_BANK_NAME_MAX, CHEQUE_NUMBER_MAX, CHEQUE_STATUS_LABELS, chequeSeries, ISRAELI_BANKS, OTHER_BANK, OTHER_BANK_LABEL } from "@/features/payments/cheques";
import { formatMoney, parseMoneyToAgorot } from "@/lib/format";

import { QUICK_SALE_CHEQUE_STATUSES, QUICK_SALE_CHEQUES_MAX, splitEvenly } from "../sale";

type Row = {
  cheque_number: string;
  cheque_bank: string;
  cheque_bank_name: string;
  cheque_branch: string;
  cheque_due_date: string;
  cheque_status: string;
  amount: string;
};

const shekels = (agorot: number) => (agorot / 100).toFixed(2);
const blank = (today: string, amount: string): Row => ({
  cheque_number: "",
  cheque_bank: "",
  cheque_bank_name: "",
  cheque_branch: "",
  cheque_due_date: today,
  cheque_status: "in_hand",
  amount,
});

/**
 * GAP-08 + PAY-04 (owner, 26 October 2026): the sale paid by a series of cheques, each its own payment. Every cheque has its
 * number, bank, branch, due date, amount and state (in hand or cleared). "חלוקה שווה" fills the rows from the first one:
 * numbers +1, due dates a month apart, the same bank and branch, the total split evenly to the agora. The rows travel as
 * JSON in the hidden input `cheques`; the server checks each one and that they add up exactly to the total.
 */
export function ChequeRows({ today, totalAgorot, error }: { today: string; totalAgorot: number | null; error?: string }) {
  const [rows, setRows] = useState<Row[]>([blank(today, totalAgorot ? shekels(totalAgorot) : "")]);
  const [count, setCount] = useState("1");
  const [note, setNote] = useState<string | null>(null);
  // a single cheque follows the total while the items change (the stored-previous-value pattern, no effect)
  const [seenTotal, setSeenTotal] = useState(totalAgorot);
  if (seenTotal !== totalAgorot) {
    setSeenTotal(totalAgorot);
    if (rows.length === 1 && totalAgorot) setRows([{ ...rows[0], amount: shekels(totalAgorot) }]);
  }
  const set = (index: number, patch: Partial<Row>) => setRows((all) => all.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const sum = rows.reduce((total, row) => total + (parseMoneyToAgorot(row.amount.trim()) ?? 0), 0);

  function fillEvenly() {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > QUICK_SALE_CHEQUES_MAX) return setNote(`מספר הצ'קים בין 1 ל-${QUICK_SALE_CHEQUES_MAX}.`);
    if (!totalAgorot) return setNote("הוסיפו פריטים כדי לחלק את הסכום.");
    const first = rows[0];
    const amounts = splitEvenly(totalAgorot, n);
    if (amounts.length === 0) return setNote("הסכום קטן מדי לחלוקה למספר הזה של צ'קים.");
    const series = /^\d{1,20}$/.test(first.cheque_number) ? chequeSeries({ number: first.cheque_number, dueDate: first.cheque_due_date || today }, n, { kind: "month" }) : null;
    setRows(
      amounts.map((amount, i) => ({
        ...first,
        cheque_number: series ? series[i].number : i === 0 ? first.cheque_number : "",
        cheque_due_date: series ? series[i].dueDate : first.cheque_due_date || today,
        amount: shekels(amount),
      })),
    );
    setNote(null);
  }

  return (
    <div className="space-y-4">
      <input
        type="hidden"
        name="cheques"
        value={JSON.stringify(rows.map((row) => ({ ...row, cheque_bank_name: row.cheque_bank === OTHER_BANK ? row.cheque_bank_name : "" })))}
      />
      <div className="flex flex-wrap items-end gap-2">
        <TextField label="מספר צ'קים" dir="ltr" inputMode="numeric" className="w-28" value={count} onChange={(event) => setCount(event.target.value)} />
        <Button variant="secondary" size="sm" onClick={fillEvenly}>
          חלוקה שווה
        </Button>
      </div>
      <p className="text-sm text-ink-soft">ממלאים את הצ&apos;ק הראשון, בוחרים כמה צ&apos;קים ולוחצים &quot;חלוקה שווה&quot;. אפשר לתקן כל צ&apos;ק אחר כך.</p>
      {note ? <p className="text-sm text-danger">{note}</p> : null}
      <ol className="space-y-4">
        {rows.map((row, index) => (
          <li key={index} className="space-y-3 rounded-md border border-line p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">צ&apos;ק {index + 1}</p>
              {rows.length > 1 ? (
                <Button variant="ghost" size="sm" aria-label={`הסרת צ'ק ${index + 1}`} onClick={() => setRows((all) => all.filter((_, i) => i !== index))}>
                  <TrashIcon className="size-4" />
                </Button>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="מספר הצ'ק"
                required
                dir="ltr"
                inputMode="numeric"
                maxLength={CHEQUE_NUMBER_MAX}
                value={row.cheque_number}
                onChange={(event) => set(index, { cheque_number: event.target.value })}
              />
              <TextField label="סכום (₪)" required dir="ltr" inputMode="decimal" value={row.amount} onChange={(event) => set(index, { amount: event.target.value })} />
              <SelectField label="בנק" required value={row.cheque_bank} onChange={(event) => set(index, { cheque_bank: event.target.value })}>
                <option value="">בחירה</option>
                {ISRAELI_BANKS.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.name} ({b.code})
                  </option>
                ))}
                <option value={OTHER_BANK}>{OTHER_BANK_LABEL}</option>
              </SelectField>
              {row.cheque_bank === OTHER_BANK ? (
                <TextField label="שם הבנק" required maxLength={CHEQUE_BANK_NAME_MAX} value={row.cheque_bank_name} onChange={(event) => set(index, { cheque_bank_name: event.target.value })} />
              ) : null}
              <TextField
                label="סניף"
                required={row.cheque_bank !== OTHER_BANK}
                dir="ltr"
                inputMode="numeric"
                maxLength={3}
                value={row.cheque_branch}
                onChange={(event) => set(index, { cheque_branch: event.target.value })}
              />
              <DateField label="תאריך פירעון" required value={row.cheque_due_date} onChange={(value) => set(index, { cheque_due_date: value })} />
              <SelectField label="מצב הצ'ק" required value={row.cheque_status} onChange={(event) => set(index, { cheque_status: event.target.value })}>
                {QUICK_SALE_CHEQUE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {CHEQUE_STATUS_LABELS[s]}
                  </option>
                ))}
              </SelectField>
            </div>
          </li>
        ))}
      </ol>
      {rows.length < QUICK_SALE_CHEQUES_MAX ? (
        <Button variant="ghost" size="sm" onClick={() => setRows((all) => [...all, blank(today, "")])}>
          צ&apos;ק נוסף
        </Button>
      ) : null}
      <p aria-live="polite" className={totalAgorot !== null && sum !== totalAgorot ? "text-sm text-danger" : "text-sm text-ink-soft"}>
        סה&quot;כ בצ&apos;קים: {formatMoney(sum)}
        {totalAgorot !== null && sum !== totalAgorot ? ` (לתשלום ${formatMoney(totalAgorot)})` : ""}
      </p>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
