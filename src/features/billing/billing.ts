// CON-08: billing details of a company or a contact, and how a contact's empty
// fields are shown from its company. Nothing is copied: the fallback is display only.

import { paymentTermsOf, type PaymentTerms } from "./terms";

export type BillingSubject = "company" | "contact";

/** The billing columns as stored (billing_tax_id exists on contacts only; a company's number is companies.tax_id). */
export type BillingColumns = {
  billing_name: string | null;
  billing_tax_id?: string | null;
  billing_address: string | null;
  shipping_address: string | null;
  billing_email: string | null;
  payment_terms: string | null;
  payment_days: number | null;
  price_list_id: string | null;
};

export const BILLING_COLUMNS = {
  company: "billing_name, billing_address, shipping_address, billing_email, payment_terms, payment_days, price_list_id",
  contact: "billing_name, billing_tax_id, billing_address, shipping_address, billing_email, payment_terms, payment_days, price_list_id",
} as const;

export type Billing = {
  name: string | null;
  taxId: string | null;
  address: string | null;
  shippingAddress: string | null;
  email: string | null;
  terms: PaymentTerms | null;
  priceListId: string | null;
};

export type BillingKey = keyof Billing;

/** One value as shown: the record's own, or its company's (`fromCompany`). */
export type ShownValue<T> = { value: T | null; fromCompany: boolean };
export type ShownBilling = { [K in BillingKey]: ShownValue<Billing[K]> };

/**
 * A company's billing. Its number is the company's own tax_id (ח.פ. / ע.מ., CON-04);
 * the invoice name falls back to nothing here: the card shows the company name as a hint.
 */
export function companyBilling(row: BillingColumns & { tax_id: string | null }): Billing {
  return {
    name: row.billing_name,
    taxId: row.tax_id,
    address: row.billing_address,
    shippingAddress: row.shipping_address,
    email: row.billing_email,
    terms: paymentTermsOf(row.payment_terms, row.payment_days),
    priceListId: row.price_list_id,
  };
}

export function contactBilling(row: BillingColumns): Billing {
  return {
    name: row.billing_name,
    taxId: row.billing_tax_id ?? null,
    address: row.billing_address,
    shippingAddress: row.shipping_address,
    email: row.billing_email,
    terms: paymentTermsOf(row.payment_terms, row.payment_days),
    priceListId: row.price_list_id,
  };
}

const KEYS: BillingKey[] = ["name", "taxId", "address", "shippingAddress", "email", "terms", "priceListId"];

/**
 * What a contact's billing card shows: each empty field of the contact takes its company's value,
 * marked as coming from the company. `company` is null when the contact has no company or the
 * user may not read it.
 */
export function effectiveBilling(own: Billing, company: Billing | null): ShownBilling {
  const shown = {} as Record<BillingKey, ShownValue<unknown>>;
  for (const key of KEYS) {
    const mine = own[key];
    if (mine !== null) {
      shown[key] = { value: mine, fromCompany: false };
    } else if (company && company[key] !== null) {
      shown[key] = { value: company[key], fromCompany: true };
    } else {
      shown[key] = { value: null, fromCompany: false };
    }
  }
  return shown as ShownBilling;
}

/** True when the record has none of its own billing details. */
export function billingIsEmpty(billing: Billing): boolean {
  return KEYS.every((key) => billing[key] === null);
}
