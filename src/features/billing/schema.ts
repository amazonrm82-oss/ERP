import { z } from "zod";

import { israeliIdNumber } from "@/lib/israeli-id";
import { optionalEmail, optionalId, optionalText } from "@/lib/validation";

import { isPaymentTermsKind, PAYMENT_DAYS_MAX } from "./terms";

// CON-08: the billing section of a company or contact form. The fields are read only when the form
// has the section (BILLING_MARKER), so forms and imports without it never clear stored values.

export const BILLING_MARKER = "billing_section";

export const BILLING_FIELD_NAMES = {
  company: ["billing_name", "billing_address", "shipping_address", "billing_email", "payment_terms", "payment_days", "price_list_id"],
  contact: ["billing_name", "billing_tax_id", "billing_address", "shipping_address", "billing_email", "payment_terms", "payment_days", "price_list_id"],
} as const;

export const BILLING_TAX_ID_INVALID = "המספר אינו תקין. מספר עוסק או ת\"ז הם 9 ספרות, והאחרונה היא ספרת ביקורת.";

const days = z
  .preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string())
  .refine((value) => value === "" || /^\d{1,3}$/.test(value), { error: `מספר הימים הוא מספר שלם בין 0 ל-${PAYMENT_DAYS_MAX}.` })
  .transform((value) => (value === "" ? null : Number(value)))
  .refine((value) => value === null || value <= PAYMENT_DAYS_MAX, { error: `מספר הימים הוא מספר שלם בין 0 ל-${PAYMENT_DAYS_MAX}.` });

const terms = optionalText(20).refine((value) => value === null || isPaymentTermsKind(value), { error: "יש לבחור תנאי תשלום מהרשימה." });

const base = z.object({
  billing_name: optionalText(200, "השם לחשבונית ארוך מדי (עד 200 תווים)."),
  billing_address: optionalText(300, "הכתובת ארוכה מדי (עד 300 תווים)."),
  shipping_address: optionalText(300, "הכתובת ארוכה מדי (עד 300 תווים)."),
  billing_email: optionalEmail,
  payment_terms: terms,
  payment_days: days,
  price_list_id: optionalId,
});

type Parsed = z.infer<typeof base> & { billing_tax_id?: string | null };

/** The payment terms pair as the database accepts it (constraint *_payment_terms_shape). */
function checkTerms(data: Parsed, ctx: z.RefinementCtx): Parsed {
  if (data.payment_terms === null) {
    return { ...data, payment_days: null };
  }
  if (data.payment_terms === "immediate") {
    return { ...data, payment_days: null };
  }
  if (data.payment_days === null) {
    if (data.payment_terms === "eom") {
      // "שוטף" alone is שוטף + 0
      return { ...data, payment_days: 0 };
    }
    ctx.addIssue({ code: "custom", path: ["payment_days"], message: "יש להזין את מספר הימים." });
    return z.NEVER;
  }
  return data;
}

export const companyBillingSchema = base.transform((data, ctx) => checkTerms(data, ctx));

export const contactBillingSchema = base
  .extend({ billing_tax_id: optionalText(20, "המספר ארוך מדי.") })
  .transform((data, ctx) => {
    if (data.billing_tax_id !== null) {
      const id = israeliIdNumber(data.billing_tax_id);
      if (!id) {
        ctx.addIssue({ code: "custom", path: ["billing_tax_id"], message: BILLING_TAX_ID_INVALID });
        return z.NEVER;
      }
      data = { ...data, billing_tax_id: id };
    }
    return checkTerms(data, ctx);
  });

export type CompanyBillingPatch = {
  billing_name: string | null;
  billing_address: string | null;
  shipping_address: string | null;
  billing_email: string | null;
  payment_terms: string | null;
  payment_days: number | null;
  price_list_id: string | null;
};

export type ContactBillingPatch = CompanyBillingPatch & { billing_tax_id: string | null };
