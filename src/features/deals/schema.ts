import { z } from "zod";

import { moneyField, optionalDate, optionalId, requiredId, requiredText } from "@/lib/validation";

export const DEAL_FIELD_NAMES = ["name", "amount", "stage_id", "contact_id", "expected_close_date"] as const;

export const createDealSchema = z.object({
  name: requiredText(200, "יש להזין שם לעסקה.", "שם העסקה ארוך מדי (עד 200 תווים)."),
  amount: moneyField,
  stage_id: requiredId("יש לבחור שלב."),
  contact_id: optionalId,
  expected_close_date: optionalDate,
});

export const moveDealSchema = z.object({
  stage_id: requiredId("יש לבחור שלב."),
});
