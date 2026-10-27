"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { agorotInput } from "@/features/deals/recurring";
import type { MoneySubject } from "@/features/payments/money-subject";
import { documentTitle, isDocumentType } from "@/features/documents/schema";
import { isPaymentMethod, PAYMENT_METHOD_LABELS } from "@/features/payments/schema";
import { formatDate, formatMoney, parseMoneyToAgorot } from "@/lib/format";

import { allocateAction, allocationOptionsAction, changeAllocationAction, linkProformaAction, undoAllocationAction } from "../actions";
import { defaultSplit, type AllocationCandidates } from "../state";

// PAY-02 (answer 8): one window, opened from a payment (its documents) or from a document (its payments).

export type AllocationOption = {
  id: string;
  label: string;
  // what this candidate can still take (a document's balance) or give (a payment's credit)
  room: number;
};

type From = { kind: "payment" | "document"; id: string; label: string };

type Props = {
  orgId: string;
  page: MoneySubject;
  from: From;
  // the payment's credit, or the document's balance
  available: number;
};

const dateLabel = (date: string) => formatDate(`${date}T12:00:00Z`);

/** The candidates the database offered, as rows of the window. */
function optionsOf(from: From, candidates: AllocationCandidates): AllocationOption[] {
  if (from.kind === "payment") {
    return candidates.documents.map((d) => ({
      id: d.id,
      label: isDocumentType(d.doc_type)
        ? d.doc_type === "opening_balance"
          ? documentTitle({ docType: d.doc_type, number: d.number, docDate: d.doc_date })
          : `${documentTitle({ docType: d.doc_type, number: d.number, docDate: d.doc_date })} מ-${dateLabel(d.doc_date)}`
        : `מסמך ${d.number ?? ""} מ-${dateLabel(d.doc_date)}`,
      room: d.balance,
    }));
  }
  return candidates.payments.map((p) => ({
    id: p.id,
    label: `${formatMoney(p.amount)} ב${isPaymentMethod(p.method) ? PAYMENT_METHOD_LABELS[p.method] : "תשלום"} מ-${dateLabel(p.paid_on)}`,
    room: p.credit,
  }));
}

export function AllocateButton({ orgId, page, from, available }: Props) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<AllocationOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const title = from.kind === "payment" ? `שיוך התשלום ${from.label} למסמכים` : `שיוך תשלומים ל${from.label}`;
  function openWindow() {
    setOpen(true);
    setOptions(null);
    setError(null);
    startTransition(async () => {
      const result = await allocationOptionsAction(orgId, { kind: from.kind, id: from.id });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOptions(result.data ? optionsOf(from, result.data) : []);
    });
  }
  return (
    <>
      <Button variant="secondary" size="sm" onClick={openWindow} aria-label={title}>
        שיוך
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={title} variant="sheet">
        {!open ? null : error ? (
          <FormError message={error} />
        ) : options === null ? (
          <p className="text-md text-ink-soft">טוענים…</p>
        ) : (
          <AllocateForm orgId={orgId} page={page} from={from} available={available} options={options} onDone={() => setOpen(false)} />
        )}
      </Dialog>
    </>
  );
}

function AllocateForm({ orgId, page, from, available, options, onDone }: Props & { options: AllocationOption[]; onDone: () => void }) {
  const [amounts, setAmounts] = useState<string[]>(() => defaultSplit(available, options.map((o) => o.room)).map((a) => (a > 0 ? agorotInput(a) : "")));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (options.length === 0) {
    return (
      <p className="text-md">
        {from.kind === "payment"
          ? "אין ללקוח הזה חשבונית מס או חשבון עסקה פתוחים. רשמו קודם את המסמך, ואז שייכו אליו את התשלום."
          : "אין ללקוח הזה תשלום עם יתרה לשיוך. רשמו קודם את התשלום, ואז שייכו אותו."}
      </p>
    );
  }
  const parsed = amounts.map((a) => parseMoneyToAgorot(a));
  const total = parsed.reduce<number>((sum, a) => sum + (a ?? 0), 0);

  function submit() {
    setError(null);
    if (parsed.some((a) => a === null)) {
      setError("אחד הסכומים לא תקין. כתבו סכום בשקלים, למשל 1500 או 1500.50.");
      return;
    }
    const rows = options.flatMap((option, i) => {
      const amount = parsed[i] ?? 0;
      if (amount <= 0) return [];
      return [from.kind === "payment" ? { paymentId: from.id, documentId: option.id, amount } : { paymentId: option.id, documentId: from.id, amount }];
    });
    if (rows.length === 0) {
      setError("כתבו סכום לפחות בשורה אחת.");
      return;
    }
    if (total > available) {
      setError(`הסכום הכולל גבוה מ-${formatMoney(available)}.`);
      return;
    }
    const over = options.findIndex((option, i) => (parsed[i] ?? 0) > option.room);
    if (over >= 0) {
      setError(`הסכום בשורה "${options[over].label}" גבוה מ-${formatMoney(options[over].room)}.`);
      return;
    }
    startTransition(async () => {
      const result = await allocateAction(orgId, page, rows);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onDone();
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-md">
        {from.kind === "payment" ? "נשאר לשיוך מהתשלום" : "היתרה של המסמך"}: <span className="font-medium tabular-nums">{formatMoney(available)}</span>. אפשר לשייך
        חלק, ולחלק בין כמה {from.kind === "payment" ? "מסמכים" : "תשלומים"}.
      </p>
      <FormError message={error} />
      <ul className="space-y-3">
        {options.map((option, i) => (
          <li key={option.id}>
            <TextField
              label={option.label}
              hint={from.kind === "payment" ? `יתרה: ${formatMoney(option.room)}` : `נשאר בתשלום: ${formatMoney(option.room)}`}
              dir="ltr"
              inputMode="decimal"
              value={amounts[i]}
              onChange={(event) => {
                const next = [...amounts];
                next[i] = event.target.value;
                setAmounts(next);
              }}
            />
          </li>
        ))}
      </ul>
      <p className="text-sm text-ink-soft">
        סך הכול לשיוך: <span className="tabular-nums">{formatMoney(total)}</span>
      </p>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button onClick={submit} disabled={pending}>
          {pending ? "משייכים…" : "שיוך"}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          חזרה
        </Button>
      </div>
    </div>
  );
}

/** Owners and admins: a new amount for an allocation. */
export function ChangeAllocationButton({ orgId, page, allocationId, amount, label }: { orgId: string; page: MoneySubject; allocationId: string; amount: number; label: string }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(agorotInput(amount));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  function submit() {
    setError(null);
    const next = parseMoneyToAgorot(value);
    if (next === null || next <= 0) {
      setError("כתבו סכום גדול מאפס, למשל 1500 או 1500.50.");
      return;
    }
    startTransition(async () => {
      const result = await changeAllocationAction(orgId, page, allocationId, next);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
    });
  }
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`שינוי הסכום של השיוך: ${label}`}>
        שינוי סכום
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`שינוי הסכום של השיוך: ${label}`} variant="sheet">
        {open ? (
          <div className="space-y-4">
            <FormError message={error} />
            <TextField label="סכום (₪)" dir="ltr" inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} />
            <div className="flex flex-wrap gap-2 pt-1">
              <Button onClick={submit} disabled={pending}>
                {pending ? "שומרים…" : "שמירה"}
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                חזרה
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

/** Owners and admins: undoes an allocation; it stays in the history. */
export function UndoAllocationButton({ orgId, page, allocationId, label }: { orgId: string; page: MoneySubject; allocationId: string; label: string }) {
  return (
    <ConfirmButton
      title={`לבטל את השיוך: ${label}?`}
      description="השיוך נשאר בהיסטוריה ולא נספר עוד. הסכום חוזר ליתרה של המסמך וליתרת הזכות של התשלום."
      confirmLabel="ביטול השיוך"
      action={() => undoAllocationAction(orgId, page, allocationId)}
    >
      ביטול שיוך
    </ConfirmButton>
  );
}

/** Answer 2: a tax invoice names the proforma it bills (once, at any time); the choices are read when the window opens. */
export function LinkProformaButton({ orgId, page, invoiceId, invoiceLabel }: { orgId: string; page: MoneySubject; invoiceId: string; invoiceLabel: string }) {
  const [open, setOpen] = useState(false);
  const [proformas, setProformas] = useState<{ id: string; label: string }[] | null>(null);
  const [picked, setPicked] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  function openWindow() {
    setOpen(true);
    setProformas(null);
    setPicked("");
    setError(null);
    startTransition(async () => {
      const result = await allocationOptionsAction(orgId, { kind: "document", id: invoiceId });
      if (!result.ok) {
        setError(result.message);
        setProformas([]);
        return;
      }
      setProformas((result.data?.proformas ?? []).map((p) => ({ id: p.id, label: `חשבון עסקה ${p.number} מ-${dateLabel(p.doc_date)} · ${formatMoney(p.amount)}` })));
    });
  }
  function submit() {
    setError(null);
    if (!picked) {
      setError("בחרו חשבון עסקה.");
      return;
    }
    startTransition(async () => {
      const result = await linkProformaAction(orgId, page, invoiceId, picked);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
    });
  }
  return (
    <>
      <Button variant="ghost" size="sm" onClick={openWindow} aria-label={`קישור ${invoiceLabel} לחשבון עסקה`}>
        קשר לחשבון עסקה
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`קישור ${invoiceLabel} לחשבון עסקה`} variant="sheet">
        {!open ? null : proformas === null ? (
          <p className="text-md text-ink-soft">טוענים…</p>
        ) : (
          <div className="space-y-4">
            <p className="text-md">
              חשבונית המס מחליפה את חשבון העסקה: התשלומים ששויכו לחשבון העסקה נספרים מעכשיו בחשבונית, וחשבון העסקה כבר לא נחשב חוב. הקישור נעשה פעם אחת.
            </p>
            <FormError message={error} />
            {proformas.length === 0 ? (
              <p className="text-md text-ink-soft">אין ללקוח הזה חשבון עסקה פתוח שעוד לא הוחלף בחשבונית.</p>
            ) : (
              <SelectField label="חשבון עסקה" value={picked} onChange={(event) => setPicked(event.target.value)} required>
                <option value="">בחירה</option>
                {proformas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </SelectField>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              {proformas.length > 0 ? (
                <Button onClick={submit} disabled={pending}>
                  {pending ? "מקשרים…" : "קישור"}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                חזרה
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
