"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { cancelAcceptedQuoteAction } from "../actions";

type Props = { orgId: string; quoteId: string };

/**
 * QUO-11 (owner, 19 October 2026): owners and admins cancel a quote the customer already accepted. A reason is required; it
 * goes into the audit log, the timeline and the notice. The customer's link then says the quote was cancelled.
 */
export function CancelAcceptedQuote({ orgId, quoteId }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger-ghost" size="sm" onClick={() => setOpen(true)}>
        ביטול ההצעה שאושרה
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="לבטל הצעה שהלקוח אישר?"
        description="הקישור של הלקוח יציג שההצעה בוטלה, בלי מחירים. הביטול והסיבה נרשמים ביומן ובציר הזמן, ומי שמטפל בהצעה מקבל התראה. העסקה לא משתנה. אי אפשר להחזיר הצעה מבוטלת."
      >
        {open ? <CancelForm orgId={orgId} quoteId={quoteId} onCancel={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

function CancelForm({ orgId, quoteId, onCancel }: Props & { onCancel: () => void }) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await cancelAcceptedQuoteAction(orgId, quoteId, prev, formData);
    if (result?.ok) onCancel();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      <TextareaField
        label="סיבת הביטול"
        name="reason"
        required
        maxLength={500}
        rows={3}
        autoFocus
        defaultValue={failure?.values?.reason ?? ""}
        error={failure?.fieldErrors?.reason}
      />
      <div className="flex flex-wrap gap-2">
        <SubmitButton variant="danger" pendingText="מבטלים…">
          ביטול ההצעה
        </SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          חזרה
        </Button>
      </div>
    </form>
  );
}
