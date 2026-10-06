import { z } from "zod";

import { parseMoneyToAgorot } from "@/lib/format";

// Shared zod building blocks for form fields. FormData gives strings (or null
// when the field is absent), so every schema starts from "string or nothing".

const raw = z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string());

/** Optional text: trimmed, "" becomes null. */
export function optionalText(max: number, tooLong = "הטקסט ארוך מדי.") {
  return raw.pipe(z.string().max(max, { error: tooLong })).transform((value) => (value === "" ? null : value));
}

/** Required text: trimmed, must not be empty. */
export function requiredText(max: number, missing: string, tooLong = "הטקסט ארוך מדי.") {
  return raw.pipe(z.string().min(1, { error: missing }).max(max, { error: tooLong }));
}

export const optionalEmail = raw
  .pipe(z.union([z.literal(""), z.email({ error: "כתובת האימייל אינה תקינה." }).max(254)]))
  .transform((value) => (value === "" ? null : value.toLowerCase()));

export const requiredEmail = raw.pipe(
  z
    .string()
    .min(1, { error: "יש להזין כתובת אימייל." })
    .pipe(z.email({ error: "כתובת האימייל אינה תקינה." }).max(254)),
);

// Lenient on purpose: the database normalises to E.164. Accepts digits with
// spaces, dashes, dots, parentheses, an optional leading + and * for short codes.
const PHONE_RE = /^\+?[\d\s\-().*]{3,24}$/;

function hasEnoughDigits(value: string): boolean {
  const digits = value.replace(/\D/g, "").length;
  return digits >= 3 && digits <= 15;
}

export const optionalPhone = raw
  .refine((value) => value === "" || (PHONE_RE.test(value) && hasEnoughDigits(value)), {
    error: "מספר הטלפון אינו תקין.",
  })
  .transform((value) => (value === "" ? null : value));

/** Optional reference to another row: "" becomes null. */
export const optionalId = raw
  .pipe(z.union([z.literal(""), z.guid({ error: "הערך שנבחר אינו תקין." })]))
  .transform((value) => (value === "" ? null : value));

export const requiredId = (missing: string) =>
  raw.pipe(z.string().min(1, { error: missing }).pipe(z.guid({ error: "הערך שנבחר אינו תקין." })));

/** Optional calendar date from <input type="date">. */
export const optionalDate = raw
  .refine((value) => value === "" || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))), {
    error: "התאריך אינו תקין.",
  })
  .transform((value) => (value === "" ? null : value));

/** "12,500" (shekels) -> agorot. Empty means 0. */
export const moneyField = raw.transform((value, ctx) => {
  const agorot = parseMoneyToAgorot(value);
  if (agorot === null) {
    ctx.addIssue({ code: "custom", message: "יש להזין סכום בשקלים, למשל 12,500." });
    return z.NEVER;
  }
  return agorot;
});

/** Checkbox: present ("on") or absent. */
export const checkbox = z.preprocess((value) => value === "on" || value === "true", z.boolean());

/** Reads the named fields of a form into a plain object for schema.safeParse(). */
export function pick(formData: FormData, names: readonly string[]): Record<string, FormDataEntryValue | null> {
  const result: Record<string, FormDataEntryValue | null> = {};
  for (const name of names) {
    result[name] = formData.get(name);
  }
  return result;
}
