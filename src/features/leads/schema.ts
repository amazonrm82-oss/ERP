import { z } from "zod";

import { checkbox, moneyField, optionalEmail, optionalId, optionalPhone, optionalText, requiredId } from "@/lib/validation";

const leadFields = {
  full_name: optionalText(200, "השם ארוך מדי (עד 200 תווים)."),
  phone: optionalPhone,
  email: optionalEmail,
  company_name: optionalText(200, "שם החברה ארוך מדי (עד 200 תווים)."),
  source_id: optionalId,
  message: optionalText(5000, "ההודעה ארוכה מדי (עד 5,000 תווים)."),
};

type Identity = { full_name: string | null; phone: string | null; email: string | null };

// Mirrors the leads_has_identity check constraint.
const hasIdentity = (lead: Identity) => Boolean(lead.full_name || lead.phone || lead.email);
const identityIssue = { path: ["full_name"], error: "יש למלא לפחות אחד מהשדות: שם, טלפון או אימייל." };

export const LEAD_FIELD_NAMES = ["full_name", "phone", "email", "company_name", "source_id", "message"] as const;

export const createLeadSchema = z
  .object({ ...leadFields, status_id: requiredId("יש לבחור סטטוס.") })
  .refine(hasIdentity, identityIssue);

export const updateLeadSchema = z.object(leadFields).refine(hasIdentity, identityIssue);

export const changeStatusSchema = z.object({
  status_id: requiredId("יש לבחור סטטוס."),
  disqualify_reason: optionalText(500, "הסיבה ארוכה מדי (עד 500 תווים)."),
});

export const convertLeadSchema = z.object({
  create_deal: checkbox,
  deal_name: optionalText(200, "שם העסקה ארוך מדי (עד 200 תווים)."),
  amount: moneyField,
});
