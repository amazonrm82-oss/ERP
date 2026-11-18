"use client";

import { useActionState, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { MoneySubject } from "@/features/payments/money-subject";
import { PAYMENT_NOTE_MAX } from "@/features/payments/schema";
import type { FormState } from "@/lib/action-result";
import { formatMoney } from "@/lib/format";

import { closeProviderRefundAction, requestProviderRefundAction } from "../refund-actions";
import type { ProviderRefundState } from "../refund-state";

// LNK-07: "החזר בכרטיס" on a payment that came from a payment link (owners and admins). The refund is asked of the provider in
// the background and recorded only after the provider answered ok. Review 4: a request nobody knows the outcome of is shown
// with "בוצע אצל הספק" / "לא בוצע", after checking at the provider; a recent failure is shown as such.

export function ProviderRefundButton({
  orgId,
  subject,
  paymentId,
  label,
  remaining,
  state,
}: {
  orgId: string;
  subject: MoneySubject;
  paymentId: string;
  label: string;
  remaining: number;
  state: ProviderRefundState;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      {state.pending !== null ? (
        <span className="text-sm text-ink-soft">{`החזר של ${formatMoney(state.pending)} ממתין לספק הסליקה`}</span>
      ) : remaining > 0 ? (
        <>
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`החזר דרך ספק הסליקה: ${label}`}>
            החזר בכרטיס
          </Button>
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            title={`החזר דרך ספק הסליקה: ${label}`}
            description={`הכסף יוחזר לכרטיס שהלקוח שילם בו, עד ${formatMoney(remaining)}. ההחזר יירשם כאן רק אחרי שספק הסליקה יאשר אותו.`}
            variant="sheet"
          >
            {open ? <ProviderRefundForm orgId={orgId} subject={subject} paymentId={paymentId} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} /> : null}
          </Dialog>
        </>
      ) : null}
      {state.failed.map((request) => (
        <span key={request.id} className="text-sm text-ink-soft">{`החזר של ${formatMoney(request.amountAgorot)} דרך ספק הסליקה לא בוצע`}</span>
      ))}
      {state.unclear.map((request) => (
        <UnclearRefund key={request.id} orgId={orgId} subject={subject} requestId={request.id} amount={request.amountAgorot} />
      ))}
    </div>
  );
}

function UnclearRefund({ orgId, subject, requestId, amount }: { orgId: string; subject: MoneySubject; requestId: string; amount: number }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const close = (outcome: "refunded_at_provider" | "not_refunded") =>
    start(async () => {
      const result = await closeProviderRefundAction(orgId, subject, requestId, outcome);
      setMessage(result.ok ? null : result.message);
    });
  return (
    <div className="space-y-1 text-sm">
      <p className="text-ink-soft">{`לא ידוע אם החזר של ${formatMoney(amount)} בוצע אצל ספק הסליקה. בדקו אצל הספק וסמנו:`}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => close("refunded_at_provider")}>
          בוצע אצל הספק
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => close("not_refunded")}>
          לא בוצע
        </Button>
      </div>
      <FormError message={message} />
    </div>
  );
}

function ProviderRefundForm({
  orgId,
  subject,
  paymentId,
  onDone,
  onCancel,
}: {
  orgId: string;
  subject: MoneySubject;
  paymentId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  // one idempotency key per opened form: a double click or a retry answers the same request
  const [key] = useState(() => crypto.randomUUID());
  const action = requestProviderRefundAction.bind(null, orgId, subject, paymentId, key);
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) onDone();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextField label="סכום ההחזר (₪)" name="amount" required dir="ltr" inputMode="decimal" defaultValue={values?.amount ?? ""} error={errors.amount} />
      <TextareaField label="הערה" name="note" rows={2} maxLength={PAYMENT_NOTE_MAX} defaultValue={values?.note ?? ""} error={errors.note} />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="שולחים…">שליחת בקשת ההחזר</SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
