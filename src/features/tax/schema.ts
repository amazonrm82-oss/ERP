import { z } from "zod";

import { israeliIdNumber } from "@/lib/israeli-id";
import { optionalEmail, optionalPhone, optionalText } from "@/lib/validation";

import { PRICES_MODE_OPTIONS } from "./prices";
import { LEGAL_FORMS, VAT_STATUS_OTHER_MAX, VAT_STATUSES } from "./status";

export const TAX_FIELD_NAMES = ["legal_form", "vat_status", "vat_status_other", "other_charges_vat"] as const;

/**
 * The tax status form (TAX-01). The VAT status is required; the name of an
 * "other" status and whether it charges VAT are required for "other" only and
 * cleared for every other status (the database check refuses anything else).
 */
export const taxSettingsSchema = z
  .object({
    legal_form: optionalText(20).refine((value) => value === null || (LEGAL_FORMS as readonly string[]).includes(value), {
      error: "יש לבחור צורת התאגדות מהרשימה.",
    }),
    vat_status: z.enum(VAT_STATUSES, { error: 'יש לבחור את המעמד במע"מ.' }),
    vat_status_other: optionalText(VAT_STATUS_OTHER_MAX, `השם ארוך מדי (עד ${VAT_STATUS_OTHER_MAX} תווים).`),
    other_charges_vat: optionalText(5),
  })
  .transform((data, ctx) => {
    const legal_form = data.legal_form as (typeof LEGAL_FORMS)[number] | null;
    if (data.vat_status !== "other") {
      return { legal_form, vat_status: data.vat_status, vat_status_other: null, other_charges_vat: null };
    }
    if (data.vat_status_other === null) {
      ctx.addIssue({ code: "custom", path: ["vat_status_other"], message: "יש לכתוב את שם המעמד." });
    }
    if (data.other_charges_vat !== "yes" && data.other_charges_vat !== "no") {
      ctx.addIssue({ code: "custom", path: ["other_charges_vat"], message: 'יש לבחור אם המעמד גובה מע"מ.' });
    }
    if (data.vat_status_other === null || (data.other_charges_vat !== "yes" && data.other_charges_vat !== "no")) {
      return z.NEVER;
    }
    return {
      legal_form,
      vat_status: data.vat_status,
      vat_status_other: data.vat_status_other,
      other_charges_vat: data.other_charges_vat === "yes",
    };
  });

export type TaxSettingsInput = z.infer<typeof taxSettingsSchema>;

export const DETAILS_FIELD_NAMES = [
  "legal_name",
  "tax_id",
  "address_line",
  "city",
  "postal_code",
  "phone",
  "email",
] as const;

export const DOCUMENT_TAX_ID_INVALID = "המספר אינו תקין. מספר עוסק או ח.פ. הם 9 ספרות, והאחרונה היא ספרת ביקורת.";

/** Digits only: spaces and dashes are dropped; "" becomes null; anything else fails. */
function digitsField(pattern: RegExp, message: string) {
  return optionalText(40).transform((value, ctx) => {
    if (value === null) return null;
    const digits = value.replace(/[\s-]/g, "");
    if (!pattern.test(digits)) {
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    }
    return digits;
  });
}

/**
 * The business details for documents (TAX-02). Everything is optional; the
 * number is checked like a company number (CON-04) and stored as 9 digits.
 * Mirrors the database checks of migration business_documents_details.
 */
export const documentDetailsSchema = z.object({
  legal_name: optionalText(120, "השם ארוך מדי (עד 120 תווים)."),
  tax_id: optionalText(30, "המספר ארוך מדי.").transform((value, ctx) => {
    if (value === null) return null;
    const number = israeliIdNumber(value);
    if (number === null) {
      ctx.addIssue({ code: "custom", message: DOCUMENT_TAX_ID_INVALID });
      return z.NEVER;
    }
    return number;
  }),
  address_line: optionalText(200, "הכתובת ארוכה מדי (עד 200 תווים)."),
  city: optionalText(100, "שם היישוב ארוך מדי."),
  postal_code: digitsField(/^(\d{5}|\d{7})$/, "מיקוד הוא 7 ספרות (או 5 ספרות בכתובת ישנה)."),
  phone: optionalPhone,
  email: optionalEmail,
});

export type DocumentDetailsInput = z.infer<typeof documentDetailsSchema>;

export const BANK_FIELD_NAMES = ["bank_name", "bank_branch", "bank_account", "bank_account_name"] as const;

/**
 * Bank details for a transfer (TAX-02 follow-up; owners and admins only). All
 * optional; an account number needs its bank and branch. Mirrors the checks of
 * migration org_bank_details.
 */
export const bankDetailsSchema = z
  .object({
    bank_name: optionalText(80, "שם הבנק ארוך מדי (עד 80 תווים)."),
    bank_branch: digitsField(/^\d{1,4}$/, "מספר סניף הוא עד 4 ספרות."),
    bank_account: digitsField(/^\d{2,20}$/, "מספר חשבון הוא ספרות בלבד, עד 20 ספרות."),
    bank_account_name: optionalText(120, "השם ארוך מדי (עד 120 תווים)."),
  })
  .superRefine((data, ctx) => {
    if (data.bank_account !== null && data.bank_name === null) {
      ctx.addIssue({ code: "custom", path: ["bank_name"], message: "יש לכתוב את שם הבנק." });
    }
    if (data.bank_account !== null && data.bank_branch === null) {
      ctx.addIssue({ code: "custom", path: ["bank_branch"], message: "יש לכתוב את מספר הסניף." });
    }
  });

export type BankDetailsInput = z.infer<typeof bankDetailsSchema>;

export const PRICES_FIELD_NAMES = ["prices_mode"] as const;

const PRICES_MODES = PRICES_MODE_OPTIONS.map((option) => option.value) as ["net", "gross"];

/** Prices before VAT or including VAT (TAX-04). */
export const pricesModeSchema = z
  .object({ prices_mode: z.enum(PRICES_MODES, { error: "יש לבחור איך מקלידים מחירים." }) })
  .transform((data) => ({ prices_include_vat: data.prices_mode === "gross" }));
