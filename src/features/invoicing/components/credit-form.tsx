"use client";

import { useActionState, useState } from "react";

import { FormError } from "@/components/ui/feedback";
import { TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";
import { formatMoney } from "@/lib/format";

import { creditAmount, CREDIT_REASON_MAX } from "../credit";
import { creditDocumentAction } from "../credit-actions";

type Props = {
  orgId: string;
  documentId: string;
  idempotencyKey: string;
  leftAgorot: number;
};

/**
 * DOC-14: a credit invoice against the original, full (everything that is left) or partial, always with a reason. Pressing
 * the button queues one request with its key (DOC-09): a second press reaches the same request. The database works out the
 * VAT share and refuses more than what is left.
 */
export function CreditForm({ orgId, documentId, idempotencyKey, leftAgorot }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(creditDocumentAction.bind(null, orgId, documentId), null);
  const values = state && !state.ok ? state.values : undefined;
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const [mode, setMode] = useState<"full" | "partial">(values?.mode === "partial" ? "partial" : "full");
  const [amount, setAmount] = useState(values?.amount ?? "");
  const checked = mode === "partial" && amount.trim() !== "" ? creditAmount("partial", amount, leftAgorot) : null;
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
        <label className="flex items-start gap-2.5 text-md">
          <input type="radio" name="mode" value="partial" checked={mode === "partial"} onChange={() => setMode("partial")} className="mt-1 size-4 accent-accent" />
          <span>זיכוי חלקי</span>
        </label>
      </fieldset>
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
      <TextareaField
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
