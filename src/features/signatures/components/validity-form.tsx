"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveSignatureValidityAction } from "../validity-actions";

type Props = {
  orgId: string;
  kind: string;
  recordId: string;
  docId: string;
  title: string;
  validUntil: string | null;
  renewalOn: string | null;
  // the signing day in the business zone: neither date may be before it
  signedDay: string | null;
  timeZone: string;
};

/** SGN-04: a signed document's last day and renewal day, for whoever may edit the record (the database decides again). */
export function SignatureValidityForm({ orgId, kind, recordId, docId, title, validUntil, renewalOn, signedDay, timeZone }: Props) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<FormState, FormData>(saveSignatureValidityAction.bind(null, orgId, kind, recordId, docId), null);
  const failure = state && !state.ok ? state : null;

  if (!open) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          {validUntil ? "עריכת תוקף" : "קביעת תוקף"}
          <span className="sr-only">: {title}</span>
        </Button>
        {state?.ok ? <FormNotice message={state.message} /> : null}
      </div>
    );
  }

  return (
    <form action={formAction} noValidate className="mt-2 space-y-3 rounded-md border border-line p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <DateField
          label="בתוקף עד"
          name="valid_until"
          defaultValue={failure?.values?.valid_until ?? validUntil ?? ""}
          min={signedDay ?? undefined}
          timeZone={timeZone}
          error={failure?.fieldErrors?.valid_until}
          hint="היום האחרון שהמסמך בתוקף. ריק = בלי תאריך."
        />
        <DateField
          label="חידוש ב-"
          name="renewal_on"
          defaultValue={failure?.values?.renewal_on ?? renewalOn ?? ""}
          min={signedDay ?? undefined}
          timeZone={timeZone}
          error={failure?.fieldErrors?.renewal_on}
          hint="מתי לטפל בחידוש. לא חובה, ולא אחרי סוף התוקף."
        />
      </div>
      <p className="text-sm text-ink-soft">לפני מועד החידוש (או סוף התוקף) נוצרת משימה למי ששלח את המסמך, לפי ההגדרה של העסק.</p>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <div className="flex flex-wrap gap-2">
        <SubmitButton size="sm" pendingText="שומרים…">
          שמירה
        </SubmitButton>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          סגירה
        </Button>
      </div>
      {state?.ok ? <FormNotice message={state.message} /> : null}
    </form>
  );
}
