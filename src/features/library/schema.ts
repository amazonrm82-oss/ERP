import { z } from "zod";

import { normalizeQrTargetUrl, QR_URL_MESSAGES } from "@/features/qr-codes/target-url";
import { checkbox, optionalDate, optionalId, optionalText, requiredText } from "@/lib/validation";

// LIB-01: an item of the content library as its form sends it. The database keeps the same rules (title 1..120,
// description up to 500, an https link by the QR link rule, the window's end on or after its start).

const LINK_MESSAGES = { ...QR_URL_MESSAGES, empty: "יש להזין את הקישור." };

const base = {
  title: requiredText(120, "יש לתת שם לפריט.", "השם ארוך מדי (עד 120 תווים)."),
  description: optionalText(500, "התיאור ארוך מדי (עד 500 תווים)."),
  category_id: optionalId,
  valid_from: optionalDate,
  valid_until: optionalDate,
  is_active: checkbox,
};

const windowOrdered = (value: { valid_from: string | null; valid_until: string | null }) =>
  value.valid_from === null || value.valid_until === null || value.valid_until >= value.valid_from;
const WINDOW_ERROR = { path: ["valid_until"], error: "תאריך הסיום צריך להיות אחרי תאריך ההתחלה או באותו יום." };

/** A link: the typed address becomes the stored https link (a typed address without a scheme gets https://). */
export const linkUrl = z.preprocess((value) => (typeof value === "string" ? value : ""), z.string()).transform((value, ctx) => {
  const link = normalizeQrTargetUrl(value);
  if (!link.ok) {
    ctx.addIssue({ code: "custom", message: LINK_MESSAGES[link.problem] });
    return z.NEVER;
  }
  return link.url;
});

export const libraryLinkSchema = z.object({ ...base, url: linkUrl }).refine(windowOrdered, WINDOW_ERROR);
export const libraryFileItemSchema = z.object(base).refine(windowOrdered, WINDOW_ERROR);

export const libraryCategorySchema = z.object({
  name: requiredText(60, "יש לתת שם לקטגוריה.", "השם ארוך מדי (עד 60 תווים)."),
});

export const LIBRARY_ITEM_FIELDS = ["title", "description", "category_id", "valid_from", "valid_until", "is_active", "url"] as const;
