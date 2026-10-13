import type { OrgBankDetailsRow, OrgDocumentSettingsRow } from "@/lib/database.types";

import { isLegalForm, isVatStatus, type LegalForm, type VatStatus } from "./status";

export type TaxSettings = {
  legalForm: LegalForm | null;
  vatStatus: VatStatus | null;
  vatStatusOther: string | null;
  otherChargesVat: boolean | null;
};

export const TAX_COLUMNS = "legal_form, vat_status, vat_status_other, other_charges_vat" as const;

/** A row of org_document_settings (or none) as tax settings; no row means nothing is set yet. */
export function taxSettingsFromRow(
  row: Pick<OrgDocumentSettingsRow, "legal_form" | "vat_status" | "vat_status_other" | "other_charges_vat"> | null,
): TaxSettings {
  return {
    legalForm: isLegalForm(row?.legal_form) ? row.legal_form : null,
    vatStatus: isVatStatus(row?.vat_status) ? row.vat_status : null,
    vatStatusOther: row?.vat_status_other ?? null,
    otherChargesVat: row?.other_charges_vat ?? null,
  };
}

/** The business as its documents show it (TAX-02). The logo is the FLD-04 logo, read with getOrgBranding(). */
export type DocumentDetails = {
  legalName: string | null;
  taxId: string | null;
  addressLine: string | null;
  city: string | null;
  postalCode: string | null;
  phone: string | null;
  email: string | null;
};

export const DETAILS_COLUMNS =
  "legal_name, tax_id, address_line, city, postal_code, phone, email" as const;

type DetailsRow = Pick<
  OrgDocumentSettingsRow,
  "legal_name" | "tax_id" | "address_line" | "city" | "postal_code" | "phone" | "email"
>;

export function documentDetailsFromRow(row: DetailsRow | null): DocumentDetails {
  return {
    legalName: row?.legal_name ?? null,
    taxId: row?.tax_id ?? null,
    addressLine: row?.address_line ?? null,
    city: row?.city ?? null,
    postalCode: row?.postal_code ?? null,
    phone: row?.phone ?? null,
    email: row?.email ?? null,
  };
}

/** "רחוב הרצל 1, תל אביב 6100000", or null when nothing is filled in. */
export function documentAddress(details: Pick<DocumentDetails, "addressLine" | "city" | "postalCode">): string | null {
  const place = [details.city, details.postalCode].filter(Boolean).join(" ");
  const text = [details.addressLine, place].filter(Boolean).join(", ");
  return text === "" ? null : text;
}

/**
 * Bank details for a transfer (TAX-02 follow-up): public.org_bank_details, read
 * and written by owners and admins only. Others see them only inside a document,
 * which keeps app.document_bank_snapshot() from the time it was made.
 */
export type BankDetails = {
  bankName: string | null;
  bankBranch: string | null;
  bankAccount: string | null;
  bankAccountName: string | null;
};

export const BANK_COLUMNS = "bank_name, bank_branch, bank_account, bank_account_name" as const;

export function bankDetailsFromRow(
  row: Pick<OrgBankDetailsRow, "bank_name" | "bank_branch" | "bank_account" | "bank_account_name"> | null,
): BankDetails {
  return {
    bankName: row?.bank_name ?? null,
    bankBranch: row?.bank_branch ?? null,
    bankAccount: row?.bank_account ?? null,
    bankAccountName: row?.bank_account_name ?? null,
  };
}

/** "בנק לאומי, סניף 800, חשבון 123456", or null without an account. */
export function bankTransferText(details: BankDetails): string | null {
  if (!details.bankAccount) return null;
  const parts = [details.bankName, details.bankBranch ? `סניף ${details.bankBranch}` : null, `חשבון ${details.bankAccount}`];
  if (details.bankAccountName) parts.push(`על שם ${details.bankAccountName}`);
  return parts.filter(Boolean).join(", ");
}
