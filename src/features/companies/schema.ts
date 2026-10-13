import { z } from "zod";

import { INDUSTRIES } from "@/features/onboarding/options";
import { optionalEmail, optionalId, optionalPhone, optionalText, requiredText } from "@/lib/validation";

import { ISRAEL, isCountryCode } from "./countries";
import { companyTaxId } from "./tax-id";

export { TAX_ID_INVALID, TAX_ID_INVALID_FOREIGN } from "./tax-id";

export const COMPANY_FIELD_NAMES = ["name", "country", "tax_id", "industry", "phone", "email", "website", "city", "address_line"] as const;

const industryValues: readonly string[] = INDUSTRIES.map((option) => option.value);

/** "example.co.il" -> "https://example.co.il". Only http(s) addresses are accepted. */
const optionalWebsite = optionalText(300, "הכתובת ארוכה מדי.").transform((value, ctx) => {
  if (value === null) {
    return null;
  }
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes(".")) {
      throw new Error("no dot");
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    ctx.addIssue({ code: "custom", message: "כתובת האתר אינה תקינה, למשל: example.co.il" });
    return z.NEVER;
  }
});

/** ISO country code; missing or empty means Israel (the database default). */
const country = optionalText(2)
  .transform((value) => (value ?? ISRAEL).toUpperCase())
  .refine(isCountryCode, { error: "יש לבחור מדינה מהרשימה." });

export const companySchema = z.object({
  name: requiredText(200, "יש להזין את שם החברה.", "השם ארוך מדי (עד 200 תווים)."),
  country,
  // checked below against the country (CON-04)
  tax_id: optionalText(30, "המספר ארוך מדי (עד 30 תווים)."),
  industry: optionalText(40).refine((value) => value === null || industryValues.includes(value), {
    error: "יש לבחור ענף מהרשימה.",
  }),
  phone: optionalPhone,
  email: optionalEmail,
  website: optionalWebsite,
  city: optionalText(100, "שם העיר ארוך מדי."),
  address_line: optionalText(200, "הכתובת ארוכה מדי."),
}).transform((data, ctx) => {
  if (data.tax_id === null) {
    return data;
  }
  const taxId = companyTaxId(data.tax_id, data.country);
  if (!taxId.ok) {
    ctx.addIssue({ code: "custom", path: ["tax_id"], message: taxId.message });
    return z.NEVER;
  }
  return { ...data, tax_id: taxId.value };
});

/**
 * CON-07: the parent company picked on the company form ("" = none). Kept apart from
 * companySchema, which the import also uses: an import never sets a parent.
 * Whether the parent may be used (readable, not in the bin, no cycle, depth) the database decides.
 */
export const parentCompanySchema = z.object({ parent_company_id: optionalId });
