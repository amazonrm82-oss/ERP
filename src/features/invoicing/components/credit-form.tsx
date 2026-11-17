"use client";

import { useActionState, useState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";
import { formatMoney } from "@/lib/format";

import { creditAmount, CREDIT_REASON_MAX, parseCreditLines, type CreditLineDraft } from "../credit";
import { creditDocumentAction, releaseCreditRequestAction } from "../credit-actions";

type Props = {
  orgId: string;
  documentId: string;
  idempotencyKey: string;
  leftAgorot: number;
  /** owner (411) ב: the original mixes exempt and taxable lines: a partial credit is made of chosen lines */
  mixed: boolean;
  /** the original's lines are prices with VAT; null = they do not give back its totals (no line credit is offered) */
  gross: boolean | null;
  lines: { id: string; description: string; vatExempt: boolean; leftAgorot: number }[];
};

/**
 * DOC-14: a credit invoice against the original, full (everything that is left) or partial, always with a reason. Pressing
 * the button queues one request with its key (DOC-09): a second press reaches the same request. The database works out the
 * VAT share and refuses more than what is left.
 */
export function CreditForm({ orgId, documentId, idempotencyKey, leftAgorot, mixed, gross, lines }: Props) {
  // a mixed original whose lines do not give back its totals is credited in full only (the database refuses the rest)
  const partialOffered = !mixed || gross !== null;
  const basis = gross ? 'כולל מע"מ' : 'לפני מע"מ';
  const [state, formAction] = useActionState<FormState, FormData>(creditDocumentAction.bind(null, orgId, documentId), null);
  const values = state && !state.ok ? state.values : undefined;
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const partialMode = mixed ? "lines" : "partial";
  const [mode, setMode] = useState<"full" | "partial" | "lines">(values?.mode === partialMode ? partialMode : "full");
  const [amount, setAmount] = useState(values?.amount ?? "");
  const [picks, setPicks] = useState<CreditLineDraft[]>(() => lines.map((line) => ({ lineId: line.id, chosen: false, amount: "" })));
  const leftByLine = new Map(lines.map((line) => [line.id, line.leftAgorot]));
  const checked =
    mode === "partial" && amount.trim() !== ""
      ? creditAmount("partial", amount, leftAgorot)
      : mode === "lines"
        ? (() => {
            const result = parseCreditLines(JSON.stringify(picks), leftByLine);
            return result.ok ? null : { ok: false as const, message: result.message };
          })()
        : null;
  const pick = (index: number, patch: Partial<CreditLineDraft>) => setPicks((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <form action={formAction} className="space-y-5">
      <FormGuard state={state} />
      <input type="hidden" name="key" value={values?.key ?? idempotencyKey} />
      <fieldset className="space-y-2">
        <legend className="text-md font-medium">כמה לזכות</legend>
        <label className="flex items-start gap-2.5 text-md">
          <input type="radio" name="mode" value="full" checked={mode === "full"} onChange={() => setMode("full")} className="mt-1 size-4 accent-accent" />
          <span>
            זיכוי מלא: <span className="tabular-nums">{formatMoney(leftAgorot)}</span>
          </span>
        </label>
        {partialOffered ? (
        <label className="flex items-start gap-2.5 text-md">
          <input type="radio" name="mode" value={partialMode} checked={mode === partialMode} onChange={() => setMode(partialMode)} className="mt-1 size-4 accent-accent" />
          <span>{mixed ? "זיכוי חלקי לפי שורות" : "זיכוי חלקי"}</span>
        </label>
        ) : (
          <p className="text-sm text-ink-soft">{'במסמך יש שורות פטורות ממע"מ ושורות חייבות, והשורות שלו לא מסתכמות בדיוק לסכומים שנרשמו. לכן אפשר כאן רק זיכוי מלא; זיכוי חלקי מפיקים אצל הספק.'}</p>
        )}
      </fieldset>
      <input type="hidden" name="lines" value={JSON.stringify(picks)} />
      {mode === "lines" ? (
        <fieldset className="space-y-3">
          <legend className="text-md font-medium">השורות לזיכוי</legend>
          <p className="text-sm text-ink-soft">{'במסמך יש שורות פטורות ממע"מ ושורות חייבות, לכן זיכוי חלקי נעשה לפי שורות. המע"מ מחושב לפי השורות שבוחרים.'}</p>
          {lines.map((line, index) => (
            <div key={line.id} className="space-y-2 rounded-lg border border-line p-3">
              <label className="flex items-start gap-2.5 text-md">
                <input
                  type="checkbox"
                  checked={picks[index]?.chosen ?? false}
                  disabled={line.leftAgorot <= 0}
                  onChange={(event) => pick(index, { chosen: event.target.checked })}
                  className="mt-1 size-4 accent-accent"
                />
                <span className="min-w-0 break-words">
                  {line.description}
                  {line.vatExempt ? ' (פטור ממע"מ)' : ""}
                  {" · נשאר "}
                  <span className="tabular-nums">{formatMoney(line.leftAgorot)}</span>
                  {` ${basis}`}
                </span>
              </label>
              {picks[index]?.chosen ? (
                <TextField
                  label={`סכום לזיכוי בשורה, ${basis} (₪)`}
                  dir="ltr"
                  inputMode="decimal"
                  value={picks[index].amount}
                  onChange={(event) => pick(index, { amount: event.target.value })}
                  hint={`ריק: כל מה שנשאר (${formatMoney(line.leftAgorot)} ${basis})`}
                />
              ) : null}
            </div>
          ))}
          {checked && !checked.ok ? <p className="text-sm text-danger">{checked.message}</p> : null}
        </fieldset>
      ) : null}
      {mode === "partial" ? (
        <TextField
          label={'סכום הזיכוי כולל מע"מ (₪)'}
          name="amount"
          dir="ltr"
          inputMode="decimal"
          required
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          hint={`עד ${formatMoney(leftAgorot)}`}
          error={errors.amount ?? (checked && !checked.ok ? checked.message : undefined)}
        />
      ) : (
        <input type="hidden" name="amount" value="" />
      )}
      <TextField
        label="סיבת הזיכוי"
        name="reason"
        required
        maxLength={CREDIT_REASON_MAX}
        defaultValue={values?.reason ?? ""}
        hint="הסיבה נשלחת לספק ומופיעה במסמך."
        error={errors.reason}
      />
      <p className="text-sm text-ink-soft">חשבונית הזיכוי מפנה למסמך המקורי. אחרי ההפקה אי אפשר לערוך אותה.</p>
      <FormError message={state && !state.ok ? state.message : null} />
      <SubmitButton disabled={checked !== null && !checked.ok} pendingText="מפיקים…">
        הפקת חשבונית זיכוי
      </SubmitButton>
    </form>
  );
}

/** DOC-14: an owner or admin releases an ended credit request that still holds its amount, after checking at the provider. */
export function ReleaseCreditButton({ orgId, documentId, requestId }: { orgId: string; documentId: string; requestId: string }) {
  return (
    <ConfirmButton
      variant="secondary"
      title="לשחרר את בקשת הזיכוי?"
      description="משחררים רק אחרי שבדקתם אצל הספק שהזיכוי הזה לא הופק שם. אחרי השחרור הסכום שלה זמין שוב לזיכוי. אם יתברר בכל זאת שהופק, רשמו אותו ידנית כחשבונית זיכוי על המסמך."
      confirmLabel="שחרור"
      action={() => releaseCreditRequestAction(orgId, documentId, requestId)}
    >
      שחרור
    </ConfirmButton>
  );
}
