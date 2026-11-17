"use client";

import { useActionState, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { ActionResult, FormState } from "@/lib/action-result";

import { closeIssueRequestAction, connectInvoiceProviderAction, disconnectInvoiceProviderAction, saveInvoiceDefaultsAction, testInvoiceConnectionAction } from "../actions";
import { DOCUMENT_TYPE_LABELS } from "@/features/documents/schema";

import { ISSUABLE_DOCUMENT_TYPES, type IssuableDocumentType, type InvoiceLocale } from "../providers/types";

/** DOC-05: connect (after the provider's own check) or test the connection. */
export function ConnectionButtons({ orgId, connected }: { orgId: string; connected: boolean }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (action: (orgId: string) => Promise<ActionResult>) =>
    startTransition(async () => {
      setResult(await action(orgId));
    });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {connected ? (
          <>
            <Button variant="secondary" loading={pending} onClick={() => run(testInvoiceConnectionAction)}>
              בדיקת החיבור
            </Button>
            <ConfirmButton
              title="לנתק את ספק החשבוניות?"
              description="אחרי הניתוק לא יהיה אפשר להפיק מסמכים מהמערכת עד שמחברים שוב. מסמכים שכבר הופקו נשארים."
              confirmLabel="ניתוק"
              action={() => disconnectInvoiceProviderAction(orgId)}
            >
              ניתוק
            </ConfirmButton>
          </>
        ) : (
          <Button loading={pending} onClick={() => run(connectInvoiceProviderAction)}>
            חיבור לספק
          </Button>
        )}
      </div>
      {result ? result.ok ? <p role="status" className="text-sm text-ink-soft">{result.message}</p> : <FormError message={result.message} /> : null}
    </div>
  );
}

type Defaults = { defaultDocType: IssuableDocumentType; locale: InvoiceLocale; sendEmail: boolean };

/** DOC-05: what a new issue starts with. */
export function InvoiceDefaultsForm({ orgId, initial }: { orgId: string; initial: Defaults }) {
  const [state, formAction] = useActionState<FormState, FormData>(saveInvoiceDefaultsAction.bind(null, orgId), null);
  return (
    <form action={formAction} className="space-y-4">
      <FormGuard state={state} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SelectField label="סוג מסמך ברירת מחדל" name="default_doc_type" defaultValue={initial.defaultDocType}>
          {ISSUABLE_DOCUMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {DOCUMENT_TYPE_LABELS[type]}
            </option>
          ))}
        </SelectField>
        <SelectField label="שפת המסמך" name="locale" defaultValue={initial.locale}>
          <option value="he">עברית</option>
          <option value="en">אנגלית</option>
        </SelectField>
      </div>
      <Checkbox name="provider_sends_email" label="הספק שולח את המסמך ללקוח באימייל" defaultChecked={initial.sendEmail} />
      <FormError message={state && !state.ok ? state.message : null} />
      {state?.ok ? <p role="status" className="text-sm text-ink-soft">{state.message}</p> : null}
      <SubmitButton>שמירה</SubmitButton>
    </form>
  );
}

/** Requests that never finished: closing one marks it unrecorded (nothing is deleted). */
export function CloseIssueRequestButton({ orgId, requestId, check = false }: { orgId: string; requestId: string; check?: boolean }) {
  return (
    <ConfirmButton
      title="לסגור את בקשת ההפקה?"
      description={
        check
          ? "סוגרים אחרי שבדקתם אצל הספק. אם המסמך הופק שם, רשמו אותו ידנית. המערכת לא תפנה לספק שוב בבקשה הזאת."
          : "אחרי הסגירה הבקשה לא תופק. אם ניסיון קודם כבר הגיע לספק, המערכת רק תבדוק אצל הספק אם המסמך הופק (בלי להפיק מסמך חדש), ואם כן תרשום אותו כאן או תשלח הודעה."
      }
      confirmLabel="סגירה"
      action={() => closeIssueRequestAction(orgId, requestId)}
    >
      סגירה
    </ConfirmButton>
  );
}
