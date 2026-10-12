import { israeliIdNumber } from "@/lib/israeli-id";

import { ISRAEL } from "./countries";

/**
 * A company's registration number (CON-04, owner's decision of 12 October 2026).
 * Optional everywhere. In Israel it is a ח.פ. or ע.מ.: 9 digits with a check digit,
 * stored padded to 9 digits. Abroad only the shape is checked: 2 to 30 characters,
 * Latin letters, digits, spaces, '-', '.' and '/', stored trimmed as typed.
 * Mirrored in the database by app.check_company_tax_id() (hints tax_id:invalid,
 * tax_id:invalid_foreign).
 */
export const TAX_ID_INVALID = "המספר אינו תקין. ח.פ. או עוסק מורשה הם 9 ספרות, והאחרונה היא ספרת ביקורת.";
export const TAX_ID_INVALID_FOREIGN =
  "מספר הרישום אינו תקין. אפשר 2 עד 30 תווים: אותיות באנגלית, ספרות, רווח, מקף, נקודה ולוכסן.";

const FOREIGN_NUMBER = /^[A-Za-z0-9 ./-]{2,30}$/;

/** The registration number of a company outside Israel, trimmed, or null when it is not valid. */
export function foreignCompanyNumber(text: string): string | null {
  const value = text.trim();
  return FOREIGN_NUMBER.test(value) ? value : null;
}

/** The value to store for a company in `country`, or the error message. */
export function companyTaxId(text: string, country: string): { ok: true; value: string } | { ok: false; message: string } {
  if (country === ISRAEL) {
    const id = israeliIdNumber(text);
    return id ? { ok: true, value: id } : { ok: false, message: TAX_ID_INVALID };
  }
  const number = foreignCompanyNumber(text);
  return number ? { ok: true, value: number } : { ok: false, message: TAX_ID_INVALID_FOREIGN };
}
