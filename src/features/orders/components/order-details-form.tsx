"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";

import { updateOrderDetailsAction } from "../actions";
import { ORDER_NOTES_MAX, ORDER_SHIPPING_MAX } from "../schema";

type Props = {
  orgId: string;
  orderId: string;
  values: { deliveryDate: string | null; shippingAddress: string | null; notes: string | null; deliveryContactId: string | null };
  // contacts to pick from for delivery; the current one is kept even when it is not in the list
  contacts: { value: string; label: string }[];
  editable: boolean;
};

/** ORD-01 (owner (2)): delivery date, shipping address, notes and the delivery contact, editable until cancelled. */
export function OrderDetailsForm({ orgId, orderId, values, contacts, editable }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(updateOrderDetailsAction.bind(null, orgId, orderId), null);
  const failed = state && !state.ok ? state : null;
  const v = (name: string, fallback: string | null) => failed?.values?.[name] ?? fallback ?? "";
  return (
    <form action={formAction} className="space-y-4">
      <FormGuard state={state} />
      <FormError message={failed?.message ?? null} />
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
      <fieldset disabled={!editable} className="space-y-4">
        <TextField
          type="date"
          name="delivery_date"
          label="מועד אספקה"
          defaultValue={v("delivery_date", values.deliveryDate)}
          error={failed?.fieldErrors?.delivery_date}
          className="max-w-48"
        />
        <SelectField name="delivery_contact_id" label="איש קשר לאספקה" defaultValue={v("delivery_contact_id", values.deliveryContactId)} error={failed?.fieldErrors?.delivery_contact_id}>
          <option value="">בלי</option>
          {contacts.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </SelectField>
        <TextareaField
          name="shipping_address"
          label="כתובת משלוח"
          rows={2}
          maxLength={ORDER_SHIPPING_MAX}
          defaultValue={v("shipping_address", values.shippingAddress)}
          error={failed?.fieldErrors?.shipping_address}
          hint="הועתקה מאיש הקשר או מהחברה כשההזמנה נוצרה. שינוי כאן לא משנה את הכרטיס שלהם."
        />
        <TextareaField
          name="notes"
          label="הערות"
          rows={3}
          maxLength={ORDER_NOTES_MAX}
          defaultValue={v("notes", values.notes)}
          error={failed?.fieldErrors?.notes}
          hint="מופיעות באישור ההזמנה שהלקוח מקבל."
        />
        {editable ? <SubmitButton>שמירה</SubmitButton> : null}
      </fieldset>
    </form>
  );
}
