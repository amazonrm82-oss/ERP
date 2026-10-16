import { z } from "zod";

import type { BusinessCardField } from "@/lib/database.types";
import { optionalText } from "@/lib/validation";

// BIZ-02: what a card can show. The rep's name, the business's display name and logo always show; each of these only
// when the rep marks it public (owner, 13 October 2026: only fields marked public). Mirror of the migration's list.
export const CARD_FIELDS: ReadonlyArray<{ key: BusinessCardField; label: string }> = [
  { key: "job_title", label: "תפקיד" },
  { key: "about", label: "כמה מילים עליי" },
  { key: "phone", label: "טלפון" },
  { key: "whatsapp", label: "כפתור WhatsApp (למספר הטלפון)" },
  { key: "email", label: "אימייל" },
  { key: "website", label: "אתר" },
];
export const CARD_FIELD_KEYS = CARD_FIELDS.map((f) => f.key);
export const DEFAULT_PUBLIC_FIELDS: BusinessCardField[] = ["job_title", "phone", "email", "whatsapp"];

const email = z
  .preprocess((v) => (typeof v === "string" ? v.trim() : ""), z.string())
  .pipe(z.union([z.literal(""), z.email({ error: "כתובת האימייל אינה תקינה." }).max(254)]))
  .transform((v) => (v === "" ? null : v.toLowerCase()));

const website = z
  .preprocess((v) => (typeof v === "string" ? v.trim() : ""), z.string())
  .pipe(z.union([z.literal(""), z.string().max(300, { error: "הכתובת ארוכה מדי." }).regex(/^https?:\/\/\S+\.\S+$/i, { error: "כתובת אתר מלאה, למשל https://example.co.il" })]))
  .transform((v) => (v === "" ? null : v));

export const cardSchema = z.object({
  job_title: optionalText(80, "התפקיד ארוך מדי (עד 80 תווים)."),
  about: optionalText(500, "הטקסט ארוך מדי (עד 500 תווים)."),
  phone: optionalText(40, "מספר הטלפון ארוך מדי."),
  email,
  website,
  public_fields: z.array(z.enum(CARD_FIELD_KEYS as [BusinessCardField, ...BusinessCardField[]])).max(CARD_FIELDS.length),
  is_active: z.boolean(),
});
export type CardInput = z.infer<typeof cardSchema>;

/** The fields to show from the form's checkboxes; one that has no value to show is left out. */
export function shownFields(input: Pick<CardInput, "job_title" | "about" | "phone" | "email" | "website">, picked: BusinessCardField[]): BusinessCardField[] {
  const has: Record<BusinessCardField, boolean> = {
    job_title: input.job_title !== null,
    about: input.about !== null,
    phone: input.phone !== null,
    whatsapp: input.phone !== null,
    email: input.email !== null,
    website: input.website !== null,
  };
  return CARD_FIELD_KEYS.filter((key) => picked.includes(key) && has[key]);
}
