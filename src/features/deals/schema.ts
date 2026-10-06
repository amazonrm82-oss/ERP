import { z } from "zod";

import { moneyField, optionalDate, optionalId, optionalText, requiredId, requiredText } from "@/lib/validation";

export const DEAL_FIELD_NAMES = ["name", "amount", "stage_id", "contact_id", "company_id", "expected_close_date"] as const;

export const createDealSchema = z.object({
  name: requiredText(200, "יש להזין שם לעסקה.", "שם העסקה ארוך מדי (עד 200 תווים)."),
  amount: moneyField,
  stage_id: requiredId("יש לבחור שלב."),
  contact_id: optionalId,
  company_id: optionalId,
  expected_close_date: optionalDate,
});

export const UPDATE_DEAL_FIELD_NAMES = ["name", "amount", "contact_id", "company_id", "expected_close_date", "lost_reason"] as const;

export const updateDealSchema = z.object({
  name: requiredText(200, "יש להזין שם לעסקה.", "שם העסקה ארוך מדי (עד 200 תווים)."),
  amount: moneyField,
  contact_id: optionalId,
  company_id: optionalId,
  expected_close_date: optionalDate,
  lost_reason: optionalText(500, "הסיבה ארוכה מדי (עד 500 תווים)."),
});

export const moveDealSchema = z.object({
  stage_id: requiredId("יש לבחור שלב."),
});
