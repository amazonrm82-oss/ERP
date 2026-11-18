"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveDocumentDeliveryAction } from "../delivery-actions";
import type { DocumentDelivery } from "../queries";

const OPTIONS: { value: DocumentDelivery; label: string; hint: string }[] = [
  {
    value: "system",
    label: "קישור למסמך",
    hint: "אנשי הצוות שולחים את הקישור מכרטיס המסמכים, בוואטסאפ או באימייל. הלקוח רואה בקישור את הסכומים ומוריד את קובץ ה-PDF.",
  },
  {
    value: "provider",
    label: "ספק החשבוניות",
    hint: "ספק החשבוניות שולח את המסמך מהאימייל שלו, למסמכים שהופקו דרכו. מסמכים שנרשמו ידנית נשלחים בקישור מכרטיס המסמכים.",
  },
];

/**
 * DOC-15 (owner (413) ג): how a document goes to the customer. Owners and admins; the default is our link. The wording says
 * what happens today: the staff send the link from the documents card; nothing is emailed automatically by our system yet
 * (DOC-15 part 3).
 */
export function DocumentDeliveryForm({ orgId, value }: { orgId: string; value: DocumentDelivery }) {
  const [state, formAction] = useActionState<FormState, FormData>(saveDocumentDeliveryAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const checked = (failure?.values?.document_delivery as DocumentDelivery | undefined) ?? value;
  return (
    <form action={formAction} noValidate className="space-y-3">
      <fieldset className="space-y-2" key={checked}>
        <legend className="text-sm font-medium">איך מסמך מגיע ללקוח</legend>
        {OPTIONS.map((option) => (
          <label key={option.value} className="flex items-start gap-2 text-sm">
            <input type="radio" name="document_delivery" value={option.value} defaultChecked={checked === option.value} className="mt-1 size-4 accent-accent" />
            <span>
              <span className="font-medium">{option.label}</span>
              <span className="block text-ink-soft">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <FormError message={failure?.fieldErrors?.document_delivery ?? failure?.message} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SubmitButton>שמירה</SubmitButton>
    </form>
  );
}
