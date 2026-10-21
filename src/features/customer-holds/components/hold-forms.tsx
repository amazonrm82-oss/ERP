"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";

import { liftHoldAction, setHoldAction } from "../actions";
import { HOLD_LABEL, HOLD_REASON_MAX, type HoldSubject } from "../schema";

function SetForm({ orgId, subject, onDone, onCancel }: { orgId: string; subject: HoldSubject; onDone: () => void; onCancel: () => void }) {
  const action = setHoldAction.bind(null, orgId, subject);
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) onDone();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <p className="text-md">מי שיוצר הצעת מחיר או הזמנה ללקוח יראה אזהרה עם הסיבה. אפשר להמשיך בכל זאת. הלקוח לא רואה את הסימון.</p>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextareaField
        label="סיבה"
        name="reason"
        required
        rows={3}
        maxLength={HOLD_REASON_MAX}
        defaultValue={failure?.values?.reason ?? ""}
        error={failure?.fieldErrors?.reason}
      />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="שומרים…">סימון</SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

/** COL-05: "סימון לא למכור" and its reason form. */
export function SetHoldButton({ orgId, subject }: { orgId: string; subject: HoldSubject }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        סימון &quot;{HOLD_LABEL}&quot;
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`סימון "${HOLD_LABEL}"`} variant="sheet">
        {open ? <SetForm orgId={orgId} subject={subject} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

/** COL-05: lifting the hold; it stays in the history. */
export function LiftHoldButton({ orgId, subject, holdId }: { orgId: string; subject: HoldSubject; holdId: string }) {
  return (
    <ConfirmButton
      variant="secondary"
      title="להסיר את הסימון?"
      description="האזהרה לא תופיע יותר ביצירת הצעה או הזמנה. הסימון נשאר ביומן הפעולות."
      confirmLabel="הסרת הסימון"
      action={liftHoldAction.bind(null, orgId, subject, holdId)}
    >
      הסרת הסימון
    </ConfirmButton>
  );
}
