import type { OrgDocumentSettingsRow } from "@/lib/database.types";

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
