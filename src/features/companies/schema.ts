import { z } from "zod";

import { INDUSTRIES } from "@/features/onboarding/options";
import { optionalEmail, optionalPhone, optionalText, requiredText } from "@/lib/validation";

export const COMPANY_FIELD_NAMES = ["name", "tax_id", "industry", "phone", "email", "website", "city", "address_line"] as const;

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

export const companySchema = z.object({
  name: requiredText(200, "יש להזין את שם החברה.", "השם ארוך מדי (עד 200 תווים)."),
  tax_id: optionalText(20, "המספר ארוך מדי."),
  industry: optionalText(40).refine((value) => value === null || industryValues.includes(value), {
    error: "יש לבחור ענף מהרשימה.",
  }),
  phone: optionalPhone,
  email: optionalEmail,
  website: optionalWebsite,
  city: optionalText(100, "שם העיר ארוך מדי."),
  address_line: optionalText(200, "הכתובת ארוכה מדי."),
});
