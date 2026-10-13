import { z } from "zod";

import { checkbox, optionalDate, requiredText } from "@/lib/validation";

// PL-01: a further price list (SPEC-ADDITIONS 4.3). The default price list is
// the product's own price and has no row. Mirrors the checks of
// public.price_lists (migration price_lists).

export const PRICE_LIST_NAME_MAX = 120;

// shown instead of the forms when the plan lacks the 'price_lists' capability
export const PRICE_LISTS_NOT_IN_PLAN =
  'מחירונים אינם כלולים בחבילה הנוכחית. מחירונים שכבר קיימים נשארים לקריאה. בעלי העסק רואים את השימוש ב"הגדרות > חבילה ושימוש", ושם גם איך מגדילים את החבילה.';

export const priceListSchema = z
  .object({
    name: requiredText(PRICE_LIST_NAME_MAX, "יש להזין שם למחירון.", `השם ארוך מדי (עד ${PRICE_LIST_NAME_MAX} תווים).`),
    valid_from: optionalDate,
    valid_to: optionalDate,
    is_active: checkbox,
  })
  // price_lists_valid_range; "YYYY-MM-DD" compares as text
  .refine((value) => value.valid_from === null || value.valid_to === null || value.valid_to >= value.valid_from, {
    path: ["valid_to"],
    error: "תאריך הסיום מוקדם מתאריך ההתחלה.",
  });

export const PRICE_LIST_FIELD_NAMES = ["name", "valid_from", "valid_to", "is_active"] as const;

export type PriceListInput = z.infer<typeof priceListSchema>;
