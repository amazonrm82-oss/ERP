"use client";

import { useState } from "react";

import { SelectField, TextField } from "@/components/ui/field";

import type { Billing, BillingSubject } from "../billing";
import type { BillingPriceList } from "../queries";
import { BILLING_MARKER } from "../schema";
import { PAYMENT_DAYS_MAX } from "../terms";

/** Form values: what is stored (as strings) or what the user typed in a failed submit. */
export type BillingFormValues = Partial<Record<string, string | null>>;

/** The stored billing as form values. */
export function billingFormValues(billing: Billing): BillingFormValues {
  return {
    billing_name: billing.name,
    billing_tax_id: billing.taxId,
    billing_address: billing.address,
    shipping_address: billing.shippingAddress,
    billing_email: billing.email,
    payment_terms: billing.terms?.kind ?? "",
    payment_days: billing.terms?.days === null || billing.terms?.days === undefined ? "" : String(billing.terms.days),
    price_list_id: billing.priceListId,
  };
}

type Props = {
  subject: BillingSubject;
  values: BillingFormValues;
  errors: Record<string, string>;
  priceLists: BillingPriceList[];
  // a contact with a company: empty fields are taken from the company
  fromCompanyHint?: boolean;
};

/** CON-08: the billing fields of a company or contact (the card's edit form and the create forms). */
export function BillingFields({ subject, values, errors, priceLists, fromCompanyHint }: Props) {
  const [terms, setTerms] = useState(values.payment_terms ?? "");
  const priceListId = values.price_list_id ?? "";
  const showPriceLists = priceLists.length > 0 || priceListId !== "";
  const emptyHint = fromCompanyHint ? "שדה ריק יוצג מפרטי החברה." : undefined;

  return (
    <div className="space-y-4">
      <input type="hidden" name={BILLING_MARKER} value="1" />
      {subject === "company" ? <p className="text-sm text-ink-soft">את ח.פ. עורכים בפרטי החברה.</p> : null}
      <TextField
        label="שם לחשבונית"
        name="billing_name"
        maxLength={200}
        autoComplete="off"
        defaultValue={values.billing_name ?? ""}
        hint={subject === "company" ? "אם ריק, החשבונית תצא על שם החברה." : emptyHint}
        error={errors.billing_name}
      />
      {subject === "contact" ? (
        <TextField
          label='מספר עוסק או ת"ז'
          name="billing_tax_id"
          dir="ltr"
          inputMode="numeric"
          maxLength={20}
          autoComplete="off"
          defaultValue={values.billing_tax_id ?? ""}
          error={errors.billing_tax_id}
          className="sm:max-w-xs"
        />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="כתובת לחיוב"
          name="billing_address"
          maxLength={300}
          autoComplete="off"
          defaultValue={values.billing_address ?? ""}
          error={errors.billing_address}
        />
        <TextField
          label="כתובת למשלוח"
          name="shipping_address"
          maxLength={300}
          autoComplete="off"
          defaultValue={values.shipping_address ?? ""}
          error={errors.shipping_address}
        />
      </div>
      <TextField
        label="אימייל לחשבוניות"
        name="billing_email"
        type="email"
        dir="ltr"
        inputMode="email"
        autoComplete="off"
        defaultValue={values.billing_email ?? ""}
        error={errors.billing_email}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="תנאי תשלום" name="payment_terms" value={terms} onChange={(event) => setTerms(event.target.value)} error={errors.payment_terms}>
          <option value="">לא נקבע</option>
          <option value="immediate">מיידי</option>
          <option value="eom">שוטף + ימים</option>
          <option value="net">ימים מתאריך המסמך</option>
        </SelectField>
        {terms === "net" || terms === "eom" ? (
          <TextField
            label="מספר ימים"
            name="payment_days"
            inputMode="numeric"
            dir="ltr"
            maxLength={3}
            autoComplete="off"
            defaultValue={values.payment_days ?? ""}
            hint={terms === "eom" ? "למשל 30 לשוטף + 30. ריק = שוטף." : `0 עד ${PAYMENT_DAYS_MAX}.`}
            error={errors.payment_days}
          />
        ) : null}
      </div>
      {showPriceLists ? (
        <SelectField key={`price-list-${priceListId}`} label="מחירון" name="price_list_id" defaultValue={priceListId} error={errors.price_list_id} className="sm:max-w-xs">
          <option value="">מחיר המוצר (ברירת המחדל)</option>
          {priceLists.map((list) => (
            <option key={list.id} value={list.id}>
              {list.isActive ? list.name : `${list.name} (לא פעיל)`}
            </option>
          ))}
        </SelectField>
      ) : (
        <input type="hidden" name="price_list_id" value="" />
      )}
    </div>
  );
}

const BILLING_ERROR_KEYS = ["billing_name", "billing_tax_id", "billing_address", "shipping_address", "billing_email", "payment_terms", "payment_days", "price_list_id"];

/** The billing fields folded under "פרטי חיוב" on a create form; open when one of them has an error. */
export function BillingSection(props: Props) {
  const open = BILLING_ERROR_KEYS.some((key) => props.errors[key]);
  return (
    <details className="rounded-md border border-line" open={open || undefined}>
      <summary className="cursor-pointer px-4 py-2.5 text-md font-medium">פרטי חיוב (לא חובה)</summary>
      <div className="px-4 pb-4">
        <BillingFields {...props} />
      </div>
    </details>
  );
}
