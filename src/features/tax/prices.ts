/**
 * Prices before VAT or including VAT (TAX-04).
 *
 * The organization picks how prices are typed and shown
 * (org_document_settings.prices_include_vat, default false = before VAT).
 * A document (quote, order, document; later waves) stores its own
 * prices_include_vat: it starts from the organization's setting when it is
 * created and may be changed on that document alone. A later change of the
 * setting never changes an existing document.
 */

export type PricesMode = "net" | "gross";

export const PRICES_MODE_OPTIONS: ReadonlyArray<{ value: PricesMode; label: string; description: string }> = [
  {
    value: "net",
    label: 'לפני מע"מ',
    description: 'מקלידים מחיר בלי מע"מ, והמע"מ מתווסף בסיכום. נוח למי שמוכר לעסקים.',
  },
  {
    value: "gross",
    label: 'כולל מע"מ',
    description: 'מקלידים את המחיר שהלקוח משלם, והמע"מ מחושב מתוכו. נוח למי שמוכר ללקוחות פרטיים.',
  },
];

/** Shown when the business charges no VAT (TAX-01): both modes give the same amounts. */
export const PRICES_NO_VAT_NOTE = 'העסק לא גובה מע"מ, ולכן הבחירה לא משנה את הסכומים.';

export function pricesModeOf(pricesIncludeVat: boolean): PricesMode {
  return pricesIncludeVat ? "gross" : "net";
}

export function pricesModeLabel(pricesIncludeVat: boolean): string {
  return PRICES_MODE_OPTIONS.find((option) => option.value === pricesModeOf(pricesIncludeVat))?.label ?? "";
}

/**
 * Whether a document's prices include VAT: its own choice when it made one,
 * else the organization's setting (no settings row = false, before VAT).
 * New documents call it with no override and store the answer.
 */
export function documentPricesIncludeVat(orgSetting: boolean | null | undefined, documentChoice?: boolean | null): boolean {
  if (typeof documentChoice === "boolean") return documentChoice;
  return orgSetting === true;
}
