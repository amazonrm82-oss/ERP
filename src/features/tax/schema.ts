import { z } from "zod";

import { optionalText } from "@/lib/validation";

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
