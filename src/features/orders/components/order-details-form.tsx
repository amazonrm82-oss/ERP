"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextareaField, TextField } from "@/components/ui/field";
import { initialChoice, pickerLabelName, type SearchPickerChoice } from "@/components/ui/search-picker-logic";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { ContactPicker } from "@/features/contacts/components/contact-picker";
import type { FormState } from "@/lib/action-result";

import { updateOrderDetailsAction } from "../actions";
import { ORDER_NOTES_MAX, ORDER_SHIPPING_MAX } from "../schema";

type Props = {
  orgId: string;
  orderId: string;
  values: { deliveryDate: string | null; shippingAddress: string | null; notes: string | null; deliveryContactId: string | null };
  // the delivery contact as it is now, named (null = none)
  deliveryContact: SearchPickerChoice;
  editable: boolean;
  // RVW-49: the texts that name a contact, in the business's own words (orders/texts.ts)
  texts: { deliveryContact: string; contact: string; shippingHint: string };
};

/** ORD-01 (owner (2)): delivery date, shipping address, notes and the delivery contact, editable until cancelled. */
export function OrderDetailsForm({ orgId, orderId, values, deliveryContact, editable, texts }: Props) {
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
        <ContactPicker
          key={failed?.values ? JSON.stringify(failed.values) : `delivery:${deliveryContact?.id ?? ""}`}
          orgId={orgId}
          name="delivery_contact_id"
          label={texts.deliveryContact}
          initial={
            failed?.values
              ? initialChoice(failed.values?.delivery_contact_id, failed.values?.[pickerLabelName("delivery_contact_id")], texts.contact)
              : deliveryContact
          }
          error={failed?.fieldErrors?.delivery_contact_id}
        />
        <TextareaField
          name="shipping_address"
          label="כתובת משלוח"
          rows={2}
          maxLength={ORDER_SHIPPING_MAX}
          defaultValue={v("shipping_address", values.shippingAddress)}
          error={failed?.fieldErrors?.shipping_address}
          hint={texts.shippingHint}
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
