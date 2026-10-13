/**
 * The business's VAT status, kept apart from its legal form (TAX-01).
 *
 * Whether VAT is charged is decided by the VAT status only, never by the legal
 * form. chargesVat() is the one rule every document uses: whoever does not
 * charge VAT shows no VAT line on any document. It mirrors
 * app.vat_status_charges() in migration tax_status (unit test keeps them equal).
 */

export const VAT_STATUSES = ["licensed", "exempt", "nonprofit", "other"] as const;
export type VatStatus = (typeof VAT_STATUSES)[number];

export const VAT_STATUS_OPTIONS: ReadonlyArray<{ value: VatStatus; label: string; description: string }> = [
  { value: "licensed", label: 'עוסק מורשה או חברה בע"מ', description: 'גובה מע"מ. המסמכים מציגים שורת מע"מ.' },
  { value: "exempt", label: "עוסק פטור", description: 'לא גובה מע"מ. אין מע"מ באף מסמך.' },
  { value: "nonprofit", label: 'עמותה או מלכ"ר', description: 'מוסד ללא כוונת רווח. לא גובה מע"מ, ואין מע"מ באף מסמך.' },
  { value: "other", label: "מעמד אחר", description: "מעמד שנקבע עם רואה החשבון. בוחרים אם הוא גובה מע\"מ." },
];

export const LEGAL_FORMS = ["individual", "company", "partnership", "nonprofit", "other"] as const;
export type LegalForm = (typeof LEGAL_FORMS)[number];

export const LEGAL_FORM_OPTIONS: ReadonlyArray<{ value: LegalForm; label: string }> = [
  { value: "individual", label: "עצמאי (עוסק יחיד)" },
  { value: "company", label: 'חברה בע"מ' },
  { value: "partnership", label: "שותפות" },
  { value: "nonprofit", label: 'עמותה או חל"צ' },
  { value: "other", label: "אחר" },
];

export const VAT_STATUS_OTHER_MAX = 80;

export function isVatStatus(value: unknown): value is VatStatus {
  return typeof value === "string" && (VAT_STATUSES as readonly string[]).includes(value);
}

export function isLegalForm(value: unknown): value is LegalForm {
  return typeof value === "string" && (LEGAL_FORMS as readonly string[]).includes(value);
}

/**
 * Whether a business with this status charges VAT on its documents.
 * null = not known (no status yet, or an "other" status without the answer):
 * document code must ask for the setting instead of guessing.
 */
export function chargesVat(status: VatStatus | null, otherChargesVat: boolean | null): boolean | null {
  switch (status) {
    case "licensed":
      return true;
    case "exempt":
    case "nonprofit":
      return false;
    case "other":
      return otherChargesVat;
    default:
      return null;
  }
}

/** The Hebrew name of a status, with the business's own name for "other". */
export function vatStatusLabel(status: VatStatus | null, otherName: string | null): string {
  if (status === null) return "לא הוגדר";
  if (status === "other") return otherName ?? "מעמד אחר";
  return VAT_STATUS_OPTIONS.find((option) => option.value === status)?.label ?? "לא הוגדר";
}
